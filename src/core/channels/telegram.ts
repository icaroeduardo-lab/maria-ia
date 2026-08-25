import type { FastifyInstance } from "fastify";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { processarMensagem, tipoPerguntaPendente } from "../chat.js";
import { filaConfigurada, enfileirar } from "../queue.js";
import { env } from "../env.js";
import { criarDedupe } from "../dedupe.js";
import { transcreverAudio } from "../transcribe.js";
import {
  MIME_ACEITOS,
  TAMANHO_MAX_BYTES,
  salvarDocumento,
  mimeReal,
  type MimeAceito,
} from "../documentos.js";
import { toTelegramPayloads } from "./telegram-payloads.js";

export { toTelegramPayloads } from "./telegram-payloads.js";

// Canal Telegram (Bot API) — alternativa de teste ao WhatsApp: sem token de
// 24h, ativação por 1 chamada a setWebhook (sem "verificação" tipo Meta).
//
// POST /webhook/telegram → recebe update, responde 200 imediato, processa async.
//
// Registro do webhook (manual, refazer sempre que a URL pública mudar — ex:
// tunnel cloudflared novo — mesma dor que o Callback URL da Meta no WhatsApp):
//   curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<PUBLIC_URL>/webhook/telegram"
// Conferir: curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
//
// Sem TELEGRAM_BOT_TOKEN configurado o sender roda em modo dev: loga o payload em vez de enviar.
//
// Documento/foto (mesmo suporte do WhatsApp, issue #74): só baixa mídia se a
// pergunta pendente da sessão for tipoPergunta "documento" (mesmo gate,
// mesmo motivo — evitar custo de download por mídia fora de contexto).
//
// Voz/áudio (mesmo suporte do WhatsApp): SEM gate — aceito em qualquer ponto
// da conversa, transcrito via AWS Transcribe (core/transcribe.ts, pipeline
// compartilhado com o WhatsApp) e tratado como se fosse texto digitado.

const API_URL = () => env.telegramApiUrl();

// ── Recebimento: formato Telegram → interno ──────────────────────────────────

export interface AtualizacaoTelegram {
  updateId: number;
  chatId: number;
  texto?: string;
  // presente quando a atualização veio de um clique em botão inline (não de
  // texto digitado) — o handler PRECISA responder answerCallbackQuery, senão
  // o botão fica "carregando" pro usuário indefinidamente.
  callbackQueryId?: string;
  // foto/documento (issue #74 estendida ao Telegram) — mirror de mediaId em
  // channels/whatsapp.ts: só guarda o file_id aqui, download é adiado pro
  // processarMensagemTelegram (depende do contexto da pergunta pendente).
  mediaId?: string;
  mediaMimeType?: string;
  mediaNomeOriginal?: string;
  // voz/áudio — mirror de audioId em channels/whatsapp.ts: só guarda o
  // file_id, download+transcrição adiados pro processarMensagemTelegram.
  audioId?: string;
}

// Telegram manda 1 update por chamada de webhook (ao contrário do formato em
// lote da Meta) — texto, resposta de botão inline, foto, documento e voz/áudio.
export function extrairAtualizacao(body: unknown): AtualizacaoTelegram | null {
  const b = body as {
    update_id?: number;
    message?: {
      chat?: { id?: number };
      text?: string;
      // array de tamanhos crescentes; o último é o maior (padrão do Telegram)
      photo?: { file_id?: string }[];
      document?: { file_id?: string; mime_type?: string; file_name?: string };
      // voice = nota de voz gravada no app; audio = arquivo de música/podcast
      // enviado — tratados igual (mesmo comportamento indiferenciado do
      // WhatsApp, que também não distingue tipos de áudio).
      voice?: { file_id?: string };
      audio?: { file_id?: string };
    };
    callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number } } };
  };

  if (b?.callback_query) {
    const cq = b.callback_query;
    const chatId = cq.message?.chat?.id;
    if (chatId == null || !cq.id) return null;
    return { updateId: b.update_id ?? 0, chatId, texto: cq.data ?? "", callbackQueryId: cq.id };
  }
  if (b?.message) {
    const chatId = b.message.chat?.id;
    if (chatId == null) return null;

    // foto: Telegram sempre reenvia comprimida em JPEG quando mandada como
    // "photo" (formato original só chega intacto via "document").
    const foto = b.message.photo;
    if (foto && foto.length > 0) {
      const maior = foto[foto.length - 1];
      if (!maior.file_id) return null;
      return {
        updateId: b.update_id ?? 0,
        chatId,
        mediaId: maior.file_id,
        mediaMimeType: "image/jpeg",
        mediaNomeOriginal: "foto.jpg",
      };
    }

    const doc = b.message.document;
    if (doc) {
      if (!doc.file_id) return null;
      return {
        updateId: b.update_id ?? 0,
        chatId,
        mediaId: doc.file_id,
        mediaMimeType: doc.mime_type,
        mediaNomeOriginal: doc.file_name ?? "documento",
      };
    }

    const audioFileId = b.message.voice?.file_id ?? b.message.audio?.file_id;
    if (audioFileId) {
      return { updateId: b.update_id ?? 0, chatId, audioId: audioFileId };
    }

    if (b.message.text == null) return null; // sem texto/mídia suportada (sticker/etc)
    return { updateId: b.update_id ?? 0, chatId, texto: b.message.text };
  }
  return null;
}

// ── Envio: content blocks internos → Bot API (em ./telegram-payloads.js) ─────

export async function enviarTelegram(chatId: number | string, messages: BaseMessage[]): Promise<void> {
  const token = env.telegramBotToken();
  const payloads = messages.flatMap((msg) => toTelegramPayloads(chatId, msg.content));
  for (const payload of payloads) {
    const { method, ...params } = payload as { method: string } & Record<string, unknown>;
    if (!token) {
      console.log(`[telegram] dev (sem TELEGRAM_BOT_TOKEN) — ${method}:`, JSON.stringify(params));
      continue;
    }
    const res = await fetch(`${API_URL()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[telegram] envio falhou HTTP ${res.status}:`, await res.text());
    }
  }
}

// Confirma o clique do botão pro cliente Telegram tirar o "carregando" — não
// depende do processamento do grafo terminar (pode levar segundos com IA/fila
// no meio), por isso é chamado no recebimento do webhook, não no fim do turno.
async function responderCallback(callbackQueryId: string): Promise<void> {
  const token = env.telegramBotToken();
  if (!token) {
    console.log("[telegram] dev (sem TELEGRAM_BOT_TOKEN) — answerCallbackQuery:", callbackQueryId);
    return;
  }
  try {
    await fetch(`${API_URL()}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[telegram] falha ao responder callback_query:", err);
  }
}

// ── Rotas ────────────────────────────────────────────────────────────────────

// dedupe de entregas repetidas do Telegram (retry de webhook) — ver ../dedupe.ts
const jaProcessado = criarDedupe();

export interface MensagemRecebidaTelegram {
  from: string;
  texto?: string;
  audioId?: string; // file_id de voice/audio → transcrito via AWS Transcribe
  mediaId?: string; // file_id do Telegram (foto/documento)
  mediaMimeType?: string;
  mediaNomeOriginal?: string;
}

// Baixa mídia da Bot API — 2 passos, igual ../graphMedia.ts (WhatsApp): getFile
// (file_id → file_path) → GET no endpoint de arquivo, que usa o TOKEN na URL
// em vez de header Authorization (diferença da Graph API da Meta). Reusada
// tanto pra foto/documento quanto pra voz/áudio (mesmo file_id → bytes).
async function baixarMidiaTelegram(fileId: string, token: string): Promise<Buffer> {
  const metaRes = await fetch(`${API_URL()}/bot${token}/getFile?file_id=${fileId}`);
  const meta = (await metaRes.json()) as { result?: { file_path?: string } };
  const filePath = meta.result?.file_path;
  if (!filePath) throw new Error("mídia sem file_path");
  const bin = await fetch(`${API_URL()}/file/bot${token}/${filePath}`);
  return Buffer.from(await bin.arrayBuffer());
}

// Baixa/valida/salva a mídia recebida (contexto já confirmado pelo chamador) e
// devolve o metadado (JSON) que vira `texto` pro processarMensagem — mesmo
// shape/contrato de processarDocumentoWA em ./whatsapp.ts. Retorna null em
// qualquer falha (já respondeu uma mensagem amigável ao assistido); nunca
// deixa a exceção vazar/travar o webhook.
export async function processarDocumentoTelegram(
  sessionId: string,
  msg: MensagemRecebidaTelegram
): Promise<string | null> {
  const erroAmigavel = async (texto: string) => {
    await enviarTelegram(msg.from, [new AIMessage(texto)]);
    return null;
  };

  const token = env.telegramBotToken();
  if (!token) {
    // modo dev (sem TELEGRAM_BOT_TOKEN): mesmo guard do WhatsApp — não tenta baixar
    console.warn("[telegram] sem TELEGRAM_BOT_TOKEN — não dá pra baixar o documento");
    return erroAmigavel("No momento não consigo receber arquivos por aqui. Pode tentar de novo mais tarde?");
  }

  const mimeDeclarado = (msg.mediaMimeType ?? "").split(";")[0].trim();
  if (!MIME_ACEITOS.includes(mimeDeclarado as MimeAceito)) {
    return erroAmigavel("Esse tipo de arquivo não é aceito. Envie uma foto (jpeg/png) ou PDF, até 10MB. 📎");
  }

  try {
    const buffer = await baixarMidiaTelegram(msg.mediaId!, token);
    if (buffer.length > TAMANHO_MAX_BYTES) {
      return erroAmigavel("O arquivo é grande demais (máx 10MB). Pode enviar uma versão menor?");
    }
    // magic bytes como fonte de verdade (mesma checagem do WhatsApp/endpoint
    // HTTP) — mime_type declarado é só um pré-filtro barato antes do download.
    const tipoReal = mimeReal(buffer);
    if (!tipoReal) {
      return erroAmigavel("Esse arquivo não parece uma foto ou PDF válido. Pode tentar de novo?");
    }
    const meta = await salvarDocumento(sessionId, buffer, tipoReal, msg.mediaNomeOriginal ?? "documento");
    return JSON.stringify(meta);
  } catch (err) {
    console.error("[telegram] falha ao processar documento:", err);
    return erroAmigavel("Não consegui processar seu arquivo agora. Pode tentar de novo?");
  }
}

// Baixa (Bot API getFile) + transcreve (AWS Transcribe, pipeline
// compartilhado com o WhatsApp) uma nota de voz/áudio. "" em qualquer falha
// (o chamador trata o fallback) — mesmo contrato de transcreverAudioWA.
export async function transcreverAudioTelegram(fileId: string, token: string | undefined): Promise<string> {
  if (!token) {
    console.warn("[telegram] sem TELEGRAM_BOT_TOKEN — não dá pra baixar o áudio");
    return "";
  }
  try {
    const audio = await baixarMidiaTelegram(fileId, token);
    return await transcreverAudio(audio, "tg");
  } catch (err) {
    console.error("[telegram] falha ao processar áudio:", err);
    return "";
  }
}

// Processa UMA atualização do Telegram: roda o grafo e responde via Bot API.
// Usado pelo worker (consumindo a fila) e, em dev sem fila, direto no webhook.
export async function processarMensagemTelegram(msg: MensagemRecebidaTelegram): Promise<void> {
  const sessionId = `tg:${msg.from}`;
  let texto = msg.texto;

  // voz/áudio: SEM gate de contexto (igual WhatsApp — aceito em qualquer
  // ponto da conversa). Falha/vazio → fallback pedindo pra escrever.
  if (msg.audioId) {
    texto = await transcreverAudioTelegram(msg.audioId, env.telegramBotToken());
    if (!texto) {
      await enviarTelegram(msg.from, [
        new AIMessage("Desculpe, não consegui entender o áudio. Pode escrever ou enviar novamente? 🎤"),
      ]);
      return;
    }
  }

  // foto/documento (issue #74 estendida ao Telegram): SÓ baixa mídia se a
  // pergunta pendente desta sessão for tipoPergunta "documento" — evita
  // custo de download/S3 e mensagem de erro sem sentido pra quem mandou
  // mídia fora de contexto (mesmo BDD do WhatsApp, ver processarMensagemWhatsApp).
  if (msg.mediaId) {
    const tipoPendente = await tipoPerguntaPendente(sessionId).catch((err) => {
      console.error("[telegram] falha ao checar pergunta pendente:", err);
      return null;
    });
    if (tipoPendente !== "documento") {
      await enviarTelegram(msg.from, [
        new AIMessage(
          "Não estou esperando um documento agora. Se precisar, é só me contar o que você precisa. 🙂"
        ),
      ]);
      return;
    }

    texto = (await processarDocumentoTelegram(sessionId, msg)) ?? undefined;
    if (texto == null) return; // erro já respondido dentro de processarDocumentoTelegram
  }

  if (texto == null) return;
  const { newMessages } = await processarMensagem(sessionId, texto, "telegram");
  await enviarTelegram(msg.from, newMessages);
}

export async function telegramRoutes(app: FastifyInstance) {
  app.post("/webhook/telegram", async (_req, reply) => {
    reply.code(200).send(); // mesmo padrão do WhatsApp: 200 rápido, processamento segue async

    (async () => {
      const atualizacao = extrairAtualizacao(_req.body);
      if (!atualizacao) return;
      if (atualizacao.callbackQueryId) await responderCallback(atualizacao.callbackQueryId);
      if (jaProcessado(String(atualizacao.updateId))) return;

      const msg = {
        id: String(atualizacao.updateId),
        from: String(atualizacao.chatId),
        texto: atualizacao.texto,
        audioId: atualizacao.audioId,
        mediaId: atualizacao.mediaId,
        mediaMimeType: atualizacao.mediaMimeType,
        mediaNomeOriginal: atualizacao.mediaNomeOriginal,
        canal: "telegram" as const,
      };
      // com fila (produção): a api só enfileira; o worker processa (mesma fila
      // FIFO do WhatsApp, MessageGroupId = chatId → serializa por conversa).
      // sem fila (dev): processa inline aqui mesmo.
      if (filaConfigurada()) {
        await enfileirar(msg);
      } else {
        await processarMensagemTelegram(msg);
      }
    })().catch((err) => console.error("[telegram] erro no processamento:", err));
  });
}
