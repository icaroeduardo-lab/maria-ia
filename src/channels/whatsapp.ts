import type { FastifyInstance } from "fastify";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { processarMensagem } from "../chat.js";
import { transcreverAudioWA } from "../transcribe.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// imagem por link é baixada async pela Meta → entrega depois do texto e quebra a
// ordem. Espera após enviar imagem pra ela chegar antes da próxima mensagem.
const DELAY_POS_IMAGEM_MS = 1200;

export async function enviarWhatsApp(to: string, messages: BaseMessage[]): Promise<void> {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;
  const payloads = messages.flatMap((msg) => toWhatsAppPayloads(to, msg.content));
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i] as { type?: string };
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
    } else if (payload.type === "image" && i < payloads.length - 1) {
      // só espera se ainda há mensagem depois (evita atraso no fim)
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
