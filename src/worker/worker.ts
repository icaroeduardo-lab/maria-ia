import "dotenv/config";
import dns from "node:dns";
// prefere IPv4 (redes com IPv6 quebrado estouram ETIMEDOUT no fetch — ex: Graph API).
dns.setDefaultResultOrder("ipv4first");

import { consumir, filaConfigurada } from "../core/queue.js";
import { validarEnv } from "../core/env.js";
import { processarMensagemWhatsApp } from "../core/channels/whatsapp.js";

// Serviço worker: consome a fila SQS e processa cada mensagem do WhatsApp
// (transcreve se áudio → roda o grafo → responde via Graph API).
async function main() {
  validarEnv();
  if (!filaConfigurada()) {
    console.error("[worker] SQS_QUEUE_URL não configurada — nada a consumir. Encerrando.");
    process.exit(1);
  }
  await consumir(processarMensagemWhatsApp);
}

main().catch((err) => {
  console.error("[worker] erro fatal:", err);
  process.exit(1);
});
