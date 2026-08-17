import type { MessageContent } from "@langchain/core/messages";

// Conversão de content blocks internos → payloads da Bot API do Telegram.
// Espelha payloads.ts (WhatsApp) propositalmente — mesma estrutura, mesmos
// content blocks, mapeamento equivalente onde a API do Telegram permite.
// Módulo puro (sem dependências de runtime) para ser testável isoladamente.

type Bloco = {
  type: string;
  text?: string;
  image_url?: { url: string };
  options?: string[];
  url?: string; // cta_url: link do botão
};

// Telegram (parse_mode "Markdown", modo clássico — não o MarkdownV2, que exige
// escapar ~10 caracteres literais e reescreveria todo o texto interno à toa):
// negrito já usa *um* asterisco, igual à convenção que o WhatsApp usa — mesma
// substituição `**` → `*` do payloads.ts.
export const formatar = (t: string) => t.replace(/\*\*/g, "*");

// callback_data do Telegram tem limite de 64 BYTES (não chars — UTF-8 conta
// bytes). Usamos o texto completo da opção como callback_data (mesma
// convenção do WhatsApp: id = texto completo da opção, não índice) enquanto
// couber; acima disso, corta em bytes sem quebrar um caractere multibyte no
// meio (evita string inválida na resposta).
export const MAX_CALLBACK_DATA_BYTES = 64;
export function truncarCallbackData(t: string, limite = MAX_CALLBACK_DATA_BYTES): string {
  if (Buffer.byteLength(t, "utf8") <= limite) return t;
  let corte = limite;
  // recua até não partir um caractere multibyte
  while (corte > 0 && (Buffer.from(t, "utf8")[corte] & 0xc0) === 0x80) corte--;
  return Buffer.from(t, "utf8").subarray(0, corte).toString("utf8");
}

export const truncar = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);

export function toTelegramPayloads(chatId: number | string, content: MessageContent): object[] {
  const base = { chat_id: chatId };
  const payloads: object[] = [];
  let textoPendente = "";

  const flushTexto = () => {
    if (!textoPendente) return;
    payloads.push({ ...base, method: "sendMessage", text: formatar(textoPendente), parse_mode: "Markdown" });
    textoPendente = "";
  };

  const blocos: Bloco[] =
    typeof content === "string" ? [{ type: "text", text: content }] : (content as Bloco[]);

  for (const b of blocos) {
    if (b.type === "text" && b.text) {
      textoPendente += (textoPendente ? "\n\n" : "") + b.text;
    } else if (b.type === "image_url" && b.image_url?.url) {
      flushTexto();
      payloads.push({ ...base, method: "sendPhoto", photo: b.image_url.url });
    } else if (b.type === "boolean") {
      payloads.push({
        ...base,
        method: "sendMessage",
        text: formatar(textoPendente || "Confirma?"),
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Sim", callback_data: "true" },
              { text: "Não", callback_data: "false" },
            ],
          ],
        },
      });
      textoPendente = "";
    } else if (b.type === "cta_url" && b.url) {
      payloads.push({
        ...base,
        method: "sendMessage",
        text: formatar(textoPendente || " "),
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: truncar(b.text || "Abrir", 20), url: b.url }]],
        },
      });
      textoPendente = "";
    } else if (b.type === "options" && b.options?.length) {
      payloads.push({
        ...base,
        method: "sendMessage",
        text: formatar(textoPendente || "Escolha uma opção:"),
        parse_mode: "Markdown",
        reply_markup: {
          // 1 botão por linha (mesma leitura vertical da lista do WhatsApp);
          // callback_data carrega o texto completo da opção (ver truncarCallbackData)
          inline_keyboard: b.options
            .slice(0, 10)
            .map((o) => [{ text: truncar(o, 64), callback_data: truncarCallbackData(o) }]),
        },
      });
      textoPendente = "";
    }
  }
  flushTexto();
  return payloads;
}
