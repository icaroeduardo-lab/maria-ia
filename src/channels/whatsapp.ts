import type { FastifyInstance } from "fastify";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { processarMensagem } from "../chat.js";
import { orgPorPhoneNumberId } from "../orgs.js";
import { prisma } from "../db.js";

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
  texto: string;
  phoneNumberId?: string; // número que RECEBEU — identifica a org (multi-tenant)
}

// Extrai mensagens de um body de webhook da Meta (entry[].changes[].value.messages[])
export function extrairMensagens(body: unknown): MensagemRecebida[] {
  const out: MensagemRecebida[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: unknown[] }[]) {
    for (const change of (entry.changes ?? []) as {
      value?: { messages?: Record<string, unknown>[]; metadata?: { phone_number_id?: string } };
    }[]) {
      for (const msg of change.value?.messages ?? []) {
        const texto = textoDaMensagem(msg);
        if (texto === null) continue;
        out.push({
          id: String(msg.id),
          from: String(msg.from),
          texto,
          phoneNumberId: change.value?.metadata?.phone_number_id,
        });
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

// ── Envio: content blocks internos → payloads Meta ──────────────────────────

type Bloco = {
  type: string;
  text?: string;
  image_url?: { url: string };
  options?: string[];
};

// WhatsApp usa *negrito* com um asterisco; markdown interno usa **
const formatar = (t: string) => t.replace(/\*\*/g, "*");
const truncar = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n - 1) + "…");

export function toWhatsAppPayloads(to: string, content: MessageContent): object[] {
  const base = { messaging_product: "whatsapp", to };
  const payloads: object[] = [];
  let textoPendente = "";

  const flushTexto = () => {
    if (!textoPendente) return;
    payloads.push({ ...base, type: "text", text: { body: formatar(textoPendente) } });
    textoPendente = "";
  };

  const blocos: Bloco[] = typeof content === "string" ? [{ type: "text", text: content }] : (content as Bloco[]);

  for (const b of blocos) {
    if (b.type === "text" && b.text) {
      textoPendente += (textoPendente ? "\n\n" : "") + b.text;
    } else if (b.type === "image_url" && b.image_url?.url) {
      flushTexto();
      payloads.push({ ...base, type: "image", image: { link: b.image_url.url } });
    } else if (b.type === "boolean") {
      // botão Sim/Não — corpo é o texto acumulado (interactive exige body)
      payloads.push({
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: formatar(textoPendente || "Confirma?") },
          action: {
            buttons: [
              { type: "reply", reply: { id: "true", title: "Sim" } },
              { type: "reply", reply: { id: "false", title: "Não" } },
            ],
          },
        },
      });
      textoPendente = "";
    } else if (b.type === "options" && b.options?.length) {
      payloads.push({
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: formatar(textoPendente || "Escolha uma opção:") },
          action: {
            button: "Escolher",
            // id carrega o texto completo da opção (title é limitado a 24 chars)
            sections: [{ title: "Opções", rows: b.options.slice(0, 10).map((o) => ({ id: o, title: truncar(o, 24) })) }],
          },
        },
      });
      textoPendente = "";
    }
  }
  flushTexto();
  return payloads;
}

export interface CredenciaisWA {
  phoneNumberId?: string;
  accessToken?: string;
}

// Credenciais da org (multi-tenant) com fallback no .env (single-tenant/dev)
async function credenciaisDaOrg(orgId: string): Promise<CredenciaisWA> {
  const padrao = { phoneNumberId: process.env.WA_PHONE_NUMBER_ID, accessToken: process.env.WA_ACCESS_TOKEN };
  if (!prisma) return padrao;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { waPhoneNumberId: true, waAccessToken: true },
  });
  return {
    phoneNumberId: org?.waPhoneNumberId ?? padrao.phoneNumberId,
    accessToken: org?.waAccessToken ?? padrao.accessToken,
  };
}

export async function enviarWhatsApp(to: string, messages: BaseMessage[], cred?: CredenciaisWA): Promise<void> {
  const phoneNumberId = cred?.phoneNumberId ?? process.env.WA_PHONE_NUMBER_ID;
  const accessToken = cred?.accessToken ?? process.env.WA_ACCESS_TOKEN;
  for (const msg of messages) {
    for (const payload of toWhatsAppPayloads(to, msg.content)) {
      if (!accessToken) {
        console.log("[whatsapp] dev (sem WA_ACCESS_TOKEN) — payload:", JSON.stringify(payload));
        continue;
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
      }
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

    (async () => {
      for (const msg of extrairMensagens(req.body)) {
        if (jaProcessado(msg.id)) continue;
        const orgId = await orgPorPhoneNumberId(msg.phoneNumberId);
        const { newMessages } = await processarMensagem(`wa:${msg.from}`, msg.texto, "whatsapp", orgId);
        await enviarWhatsApp(msg.from, newMessages, await credenciaisDaOrg(orgId));
      }
    })().catch((err) => console.error("[whatsapp] erro no processamento:", err));
  });
}
