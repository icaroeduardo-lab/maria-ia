import type { FastifyInstance } from "fastify";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { processarMensagem } from "../chat.js";
import { transcreverAudioWA } from "../transcribe.js";
import { toWhatsAppPayloads, formatar } from "./payloads.js";

export { toWhatsAppPayloads } from "./payloads.js";

// Canal WhatsApp Business Cloud API (Meta).
// GET  /webhook/whatsapp → verificação do webhook (challenge)
// POST /webhook/whatsapp → recebe mensagens, roda o grafo e responde via Graph API
//
// Sem WA_ACCESS_TOKEN configurado o sender roda em modo dev: loga o payload em vez de enviar.

const GRAPH_URL = () => process.env.WA_GRAPH_URL ?? "https://graph.facebook.com";
const API_VERSION = () => process.env.WA_API_VERSION ?? "v23.0";

// ── Recebimento: formato Meta → interno ─────────────────────────────────────

interface MensagemRecebida {
  id: string;
  from: string;   // wa_id, ex: "5521999990000"
  texto?: string;
  audioId?: string; // mensagem de voz → transcrita via AWS Transcribe
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
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;
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

export async function whatsappRoutes(app: FastifyInstance) {
  app.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === process.env.WA_WEBHOOK_VERIFY_TOKEN) {
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
        let texto = msg.texto;
        // mensagem de voz → transcreve (AWS Transcribe) e usa como texto
        if (msg.audioId) {
          texto = await transcreverAudioWA(msg.audioId, process.env.WA_ACCESS_TOKEN);
          if (!texto) {
            await enviarWhatsApp(msg.from, [
              new AIMessage("Desculpe, não consegui entender o áudio. Pode escrever ou enviar novamente? 🎤"),
            ]);
            continue;
          }
        }
        if (texto == null) continue;
        const { newMessages } = await processarMensagem(`wa:${msg.from}`, texto, "whatsapp");
        await enviarWhatsApp(msg.from, newMessages);
      }
    })().catch((err) => console.error("[whatsapp] erro no processamento:", err));
  });
}
