import type { MessageContent } from "@langchain/core/messages";

// Conversão de content blocks internos → payloads da Cloud API do WhatsApp.
// Módulo puro (sem dependências de runtime) para ser testável isoladamente.

type Bloco = {
  type: string;
  text?: string;
  image_url?: { url: string };
  options?: string[];
  url?: string; // cta_url: link do botão
};

// WhatsApp usa *negrito* com um asterisco; markdown interno usa **
export const formatar = (t: string) => t.replace(/\*\*/g, "*");
export const truncar = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n - 1) + "…");

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
    } else if (b.type === "cta_url" && b.url) {
      // botão que abre um link (WhatsApp exige URL https). Rótulo em b.text.
      payloads.push({
        ...base,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: formatar(textoPendente || " ") },
          action: {
            name: "cta_url",
            parameters: { display_text: truncar(b.text || "Abrir", 20), url: b.url },
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
