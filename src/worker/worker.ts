import "dotenv/config";
import dns from "node:dns";
// prefere IPv4 (redes com IPv6 quebrado estouram ETIMEDOUT no fetch — ex: Graph API).
dns.setDefaultResultOrder("ipv4first");

import { consumir, filaConfigurada, type MsgFila } from "../core/queue.js";
import { validarEnv } from "../core/env.js";
import { processarMensagemWhatsApp } from "../core/channels/whatsapp.js";
import { processarMensagemTelegram } from "../core/channels/telegram.js";

// Serviço worker: consome a fila SQS FIFO compartilhada (WhatsApp + Telegram)
// e despacha por `canal` (ausente = whatsapp, compat com mensagens
// enfileiradas antes do Telegram existir — ver core/queue.ts).
async function processarMensagemFila(msg: MsgFila): Promise<void> {
  if (msg.canal === "telegram") return processarMensagemTelegram(msg);
  return processarMensagemWhatsApp(msg);
}

async function main() {
  validarEnv();
  if (!filaConfigurada()) {
    console.error("[worker] SQS_QUEUE_URL não configurada — nada a consumir. Encerrando.");
    process.exit(1);
  }
  await consumir(processarMensagemFila);
}

main().catch((err) => {
  console.error("[worker] erro fatal:", err);
  process.exit(1);
});
