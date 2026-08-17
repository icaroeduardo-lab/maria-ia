import type { FastifyInstance } from "fastify";
import type { BaseMessage } from "@langchain/core/messages";
import { processarMensagem } from "../chat.js";
import { filaConfigurada, enfileirar } from "../queue.js";
import { env } from "../env.js";
import { criarDedupe } from "../dedupe.js";
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

const API_URL = () => env.telegramApiUrl();

// ── Recebimento: formato Telegram → interno ──────────────────────────────────

export interface AtualizacaoTelegram {
  updateId: number;
  chatId: number;
  texto: string;
  // presente quando a atualização veio de um clique em botão inline (não de
  // texto digitado) — o handler PRECISA responder answerCallbackQuery, senão
  // o botão fica "carregando" pro usuário indefinidamente.
  callbackQueryId?: string;
}

// Telegram manda 1 update por chamada de webhook (ao contrário do formato em
// lote da Meta) — sem suporte a mídia/áudio por enquanto (fora do escopo
// inicial: só texto e resposta de botão inline).
export function extrairAtualizacao(body: unknown): AtualizacaoTelegram | null {
  const b = body as {
    update_id?: number;
    message?: { chat?: { id?: number }; text?: string };
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
    if (chatId == null || b.message.text == null) return null; // sem texto (foto/sticker/etc) — sem suporte por enquanto
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

// Processa UMA atualização do Telegram: roda o grafo e responde via Bot API.
// Usado pelo worker (consumindo a fila) e, em dev sem fila, direto no webhook.
export async function processarMensagemTelegram(msg: { from: string; texto?: string }): Promise<void> {
  if (msg.texto == null) return;
  const { newMessages } = await processarMensagem(`tg:${msg.from}`, msg.texto, "telegram");
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
