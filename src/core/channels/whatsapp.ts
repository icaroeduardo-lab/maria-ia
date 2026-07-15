import type { FastifyInstance } from "fastify";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { processarMensagem, tipoPerguntaPendente } from "../chat.js";
import { transcreverAudioWA } from "../transcribe.js";
import { baixarMidia } from "../graphMedia.js";
import { filaConfigurada, enfileirar } from "../queue.js";
import { env } from "../env.js";
import { cacheIncr, cacheGet, cacheSet } from "../cache.js";
import { MIME_ACEITOS, TAMANHO_MAX_BYTES, salvarDocumento, mimeReal, type MimeAceito } from "../documentos.js";
import { toWhatsAppPayloads, } from "./payloads.js";

export { toWhatsAppPayloads } from "./payloads.js";

// Canal WhatsApp Business Cloud API (Meta).
// GET  /webhook/whatsapp → verificação do webhook (challenge)
// POST /webhook/whatsapp → recebe mensagens, roda o grafo e responde via Graph API
//
// Sem WA_ACCESS_TOKEN configurado o sender roda em modo dev: loga o payload em vez de enviar.

const GRAPH_URL = () => env.waGraphUrl();
const API_VERSION = () => env.waApiVersion();

// ── Recebimento: formato Meta → interno ─────────────────────────────────────

export interface MensagemRecebida {
  id: string;
  from: string;   // wa_id, ex: "5521999990000"
  texto?: string;
  audioId?: string; // mensagem de voz → transcrita via AWS Transcribe
  // imagem/documento (issue #74) — mirror de audioId: só guarda o id aqui,
  // download é adiado pro processarMensagemWhatsApp (depende do contexto da
  // pergunta pendente, ver tipoPerguntaPendente em core/chat.ts)
  mediaId?: string;
  mediaMimeType?: string;
  mediaNomeOriginal?: string;
}

// Extrai mensagens de um body de webhook da Meta (entry[].changes[].value.messages[])
export function extrairMensagens(body: unknown): MensagemRecebida[] {
  const out: MensagemRecebida[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: unknown[] }[]) {
    for (const change of (entry.changes ?? []) as {
      value?: { messages?: Record<string, unknown>[] };
    }[]) {
      for (const msg of change.value?.messages ?? []) {
        // áudio (voz): guarda o id da mídia p/ transcrever no handler
        if (msg.type === "audio") {
          const audioId = (msg.audio as { id?: string })?.id;
          if (audioId) out.push({ id: String(msg.id), from: String(msg.from), audioId });
          continue;
        }
        // imagem/documento (comprovante, identidade etc — issue #74): guarda
        // id/mime/nome; download só acontece se a pergunta pendente esperar
        // documento (ver processarMensagemWhatsApp)
        if (msg.type === "image" || msg.type === "document") {
          const media = (msg[msg.type] as { id?: string; mime_type?: string; filename?: string }) ?? {};
          if (media.id) {
            out.push({
              id: String(msg.id),
              from: String(msg.from),
              mediaId: media.id,
              mediaMimeType: media.mime_type,
              mediaNomeOriginal: media.filename,
            });
          }
          continue;
        }
        const texto = textoDaMensagem(msg);
        if (texto === null) continue;
        out.push({ id: String(msg.id), from: String(msg.from), texto });
      }
    }
  }
  return out;
}

function textoDaMensagem(msg: Record<string, unknown>): string | null {
  const m = msg as {
    type?: string;
    text?: { body?: string };
    interactive?: { type?: string; button_reply?: { id?: string }; list_reply?: { id?: string } };
    button?: { payload?: string; text?: string };
  };
  switch (m.type) {
    case "text":
      return m.text?.body ?? "";
    case "interactive":
      // ids carregam o valor interno: "true"/"false" nos botões, texto da opção nas listas
      return m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? "";
    case "button":
      return m.button?.payload ?? m.button?.text ?? "";
    default:
      return null; // mídia/áudio/etc — sem suporte por enquanto
  }
}

// ── Envio: content blocks internos → payloads Meta (em ./payloads.js) ────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// fallback: imagem por link é baixada async pela Meta → entrega depois do texto
// e quebra a ordem. Quando não dá pra usar media-id, espera após a imagem.
const DELAY_POS_IMAGEM_MS = 1200;

// cache de media-id por URL (imagens fixas — saudação etc — sobem 1x só)
const mediaIdCache = new Map<string, string>();

// Sobe a imagem pra Media API e devolve o media-id (entrega determinística, sem
// download async como no link). Só jpeg/png; outros formatos → null (usa link).
async function uploadMedia(linkUrl: string, phoneNumberId: string, token: string): Promise<string | null> {
  const cached = mediaIdCache.get(linkUrl);
  if (cached) return cached;
  try {
    const img = await fetch(linkUrl, { signal: AbortSignal.timeout(15_000) });
    if (!img.ok) return null;
    const tipo = img.headers.get("content-type") ?? "image/jpeg";
    if (!/^image\/(jpeg|png)$/.test(tipo)) return null; // webp/etc não dá upload de imagem
    const blob = await img.blob();
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", tipo);
    form.append("file", blob, "imagem");
    const res = await fetch(`${GRAPH_URL()}/${API_VERSION()}/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const id = ((await res.json()) as { id?: string }).id ?? null;
    if (id) mediaIdCache.set(linkUrl, id);
    return id;
  } catch {
    return null;
  }
}

export async function enviarWhatsApp(to: string, messages: BaseMessage[]): Promise<void> {
  const phoneNumberId = env.waPhoneNumberId();
  const accessToken = env.waAccessToken();
  const payloads = messages.flatMap((msg) => toWhatsAppPayloads(to, msg.content));
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i] as { type?: string; image?: { link?: string; id?: string } };
    if (!accessToken) {
      console.log("[whatsapp] dev (sem WA_ACCESS_TOKEN) — payload:", JSON.stringify(payload));
      continue;
    }

    // imagem: tenta media-id (ordem determinística); se falhar, mantém o link
    let usouLink = false;
    if (payload.type === "image" && payload.image?.link && phoneNumberId) {
      const mediaId = await uploadMedia(payload.image.link, phoneNumberId, accessToken);
      if (mediaId) payload.image = { id: mediaId };
      else usouLink = true;
    }

    const url = `${GRAPH_URL()}/${API_VERSION()}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[whatsapp] envio falhou HTTP ${res.status}:`, await res.text());
    } else if (payload.type === "image" && usouLink && i < payloads.length - 1) {
      // só espera quando caiu no fallback de link (media-id já entrega em ordem)
      await sleep(DELAY_POS_IMAGEM_MS);
    }
  }
}

// ── Rotas ────────────────────────────────────────────────────────────────────

// dedupe de entregas repetidas da Meta (retry de webhook)
const processados = new Set<string>();
function jaProcessado(id: string): boolean {
  if (processados.has(id)) return true;
  processados.add(id);
  if (processados.size > 1000) {
    for (const antigo of processados) {
      processados.delete(antigo);
      if (processados.size <= 500) break;
    }
  }
  return false;
}

// Rate limit por número (card #20260122) — janela fixa de 60s, via cacheIncr
// (Redis com fallback em memória; NUNCA bloqueia por falha do limiter).
// Roda DEPOIS do dedupe por message.id, ANTES de enfileirar/processar.
function mascararNumero(numero: string): string {
  return numero.length > 4 ? `***${numero.slice(-4)}` : "***";
}

async function dentroDoLimite(numero: string): Promise<boolean> {
  const n = await cacheIncr(`wa:ratelimit:${numero}`, 60);
  return n <= env.waRateLimitMsgsMin();
}

// avisa só 1x por janela — senão o próprio aviso vira flood de resposta
async function avisarLimiteExcedido(numero: string): Promise<void> {
  const chaveAviso = `wa:ratelimit:aviso:${numero}`;
  if (await cacheGet<boolean>(chaveAviso)) return;
  await cacheSet(chaveAviso, true, 60);
  console.warn(`[whatsapp] rate limit excedido — número ${mascararNumero(numero)}`);
  await enviarWhatsApp(numero, [
    new AIMessage("Recebi muitas mensagens suas bem rapidinho! 🙏 Me dá um instante e manda de novo em instantes."),
  ]).catch((err) => console.error("[whatsapp] falha ao avisar rate limit:", err));
}

// Processa UMA mensagem do WhatsApp: transcreve (se áudio), roda o grafo e
// responde via Graph API. Usado pelo worker (consumindo a fila) e, em dev sem
// fila, direto no webhook.
export async function processarMensagemWhatsApp(msg: MensagemRecebida): Promise<void> {
  let texto = msg.texto;
  if (msg.audioId) {
    texto = await transcreverAudioWA(msg.audioId, env.waAccessToken());
    if (!texto) {
      await enviarWhatsApp(msg.from, [
        new AIMessage("Desculpe, não consegui entender o áudio. Pode escrever ou enviar novamente? 🎤"),
      ]);
      return;
    }
  }

  // imagem/documento (issue #74): SÓ baixa mídia se a pergunta pendente desta
  // sessão for tipoPergunta "documento" — evita custo de download/S3 e uma
  // mensagem de erro sem sentido (tipo "CPF inválido") pra quem mandou foto
  // fora de contexto (BDD: WhatsApp checa contexto ANTES de baixar mídia).
  if (msg.mediaId) {
    const sessionId = `wa:${msg.from}`;
    const tipoPendente = await tipoPerguntaPendente(sessionId).catch((err) => {
      console.error("[whatsapp] falha ao checar pergunta pendente:", err);
      return null;
    });
    if (tipoPendente !== "documento") {
      await enviarWhatsApp(msg.from, [
        new AIMessage("Não estou esperando um documento agora. Se precisar, é só me contar o que você precisa. 🙂"),
      ]);
      return;
    }

    texto = (await processarDocumentoWA(sessionId, msg)) ?? undefined;
    if (texto == null) return; // erro já respondido dentro de processarDocumentoWA
  }

  if (texto == null) return;
  const { newMessages } = await processarMensagem(`wa:${msg.from}`, texto, "whatsapp");
  await enviarWhatsApp(msg.from, newMessages);
}

// Baixa/valida/salva a mídia recebida (contexto já confirmado pelo chamador)
// e devolve o metadado (JSON) que vira `texto` pro processarMensagem — mesmo
// shape de POST /api/upload-documento (validacao-resposta.ts VALIDADORES.documento).
// Retorna null em qualquer falha (já respondeu uma mensagem amigável ao
// assistido); nunca deixa a exceção vazar/travar o webhook.
async function processarDocumentoWA(sessionId: string, msg: MensagemRecebida): Promise<string | null> {
  const erroAmigavel = async (texto: string) => {
    await enviarWhatsApp(msg.from, [new AIMessage(texto)]);
    return null;
  };

  const token = env.waAccessToken();
  if (!token) {
    // modo dev (sem WA_ACCESS_TOKEN): mesmo guard do áudio — não tenta baixar
    console.warn("[whatsapp] sem WA_ACCESS_TOKEN — não dá pra baixar o documento");
    return erroAmigavel("No momento não consigo receber arquivos por aqui. Pode tentar de novo mais tarde?");
  }

  const mimeDeclarado = (msg.mediaMimeType ?? "").split(";")[0].trim();
  if (!MIME_ACEITOS.includes(mimeDeclarado as MimeAceito)) {
    return erroAmigavel("Esse tipo de arquivo não é aceito. Envie uma foto (jpeg/png) ou PDF, até 10MB. 📎");
  }

  try {
    const buffer = await baixarMidia(msg.mediaId!, token);
    if (buffer.length > TAMANHO_MAX_BYTES) {
      return erroAmigavel("O arquivo é grande demais (máx 10MB). Pode enviar uma versão menor?");
    }
    // magic bytes como fonte de verdade (mesma checagem do endpoint HTTP) —
    // mime_type da Meta é só um pré-filtro barato antes do download.
    const tipoReal = mimeReal(buffer);
    if (!tipoReal) {
      return erroAmigavel("Esse arquivo não parece uma foto ou PDF válido. Pode tentar de novo?");
    }
    const meta = await salvarDocumento(sessionId, buffer, tipoReal, msg.mediaNomeOriginal ?? "documento");
    return JSON.stringify(meta);
  } catch (err) {
    console.error("[whatsapp] falha ao processar documento:", err);
    return erroAmigavel("Não consegui processar seu arquivo agora. Pode tentar de novo?");
  }
}

export async function whatsappRoutes(app: FastifyInstance) {
  app.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === env.waWebhookVerifyToken()) {
      return reply.send(q["hub.challenge"]);
    }
    return reply.code(403).send();
  });

  app.post("/webhook/whatsapp", async (req, reply) => {
    reply.code(200).send(); // Meta exige 200 rápido; processamento segue async

    // statuses de entrega da Meta: loga só falhas (erro + motivo) — sem spam de sent/delivered/read
    try {
      type Status = { status?: string; recipient_id?: string; errors?: { code?: number; title?: string }[] };
      const body = req.body as { entry?: { changes?: { value?: { statuses?: Status[] } }[] }[] };
      for (const entry of body.entry ?? [])
        for (const change of entry.changes ?? [])
          for (const st of change.value?.statuses ?? [])
            if (st.status === "failed") {
              const e = st.errors?.[0];
              console.error(`[whatsapp] entrega falhou para ${st.recipient_id}: ${e?.code} ${e?.title}`);
            }
    } catch { /* ignora */ }

    (async () => {
      for (const msg of extrairMensagens(req.body)) {
        if (jaProcessado(msg.id)) continue;
        if (!(await dentroDoLimite(msg.from))) {
          await avisarLimiteExcedido(msg.from);
          continue;
        }
        // com fila (produção): a api só enfileira; o worker processa.
        // sem fila (dev): processa inline aqui mesmo.
        if (filaConfigurada()) {
          await enfileirar(msg);
        } else {
          await processarMensagemWhatsApp(msg);
        }
      }
    })().catch((err) => console.error("[whatsapp] erro no processamento:", err));
  });
}
