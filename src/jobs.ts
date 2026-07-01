import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { processarFila } from "./dperj.js";
import { limparConversasInativas } from "./limpeza.js";
import { avisarSeTokenMorto } from "./health.js";

// Entrypoint dos jobs agendados (EventBridge → RunTask com este comando).
// Uso: node dist/jobs.js <retry-dperj|limpeza|health>
const jobs: Record<string, () => Promise<unknown>> = {
  "retry-dperj": processarFila,
  "limpeza": limparConversasInativas,
  "health": avisarSeTokenMorto,
};

async function main() {
  const nome = process.argv[2];
  const job = jobs[nome];
  if (!job) {
    console.error(`[jobs] job desconhecido: "${nome}". Use: ${Object.keys(jobs).join(" | ")}`);
    process.exit(1);
  }
  console.log(`[jobs] iniciando "${nome}"`);
  await job();
  console.log(`[jobs] "${nome}" concluído`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[jobs] erro:", err);
  process.exit(1);
});
