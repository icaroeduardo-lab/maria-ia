import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import pg from "pg";
import { processarFila } from "../core/dperj.js";
import { limparConversasInativas } from "../core/limpeza.js";
import { avisarSeTokenMorto } from "../core/health.js";
import { env, validarEnv } from "../core/env.js";

// Limpa os checkpoints das threads de WhatsApp (recomeça as conversas do zero).
// Útil em demo/teste quando o estado de uma conversa fica travado.
async function resetWhatsApp(): Promise<void> {
  const url = (env.databaseUrl() ?? "").replace(/sslmode=require/i, "sslmode=no-verify");
  const cli = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await cli.connect();
  let total = 0;
  for (const t of ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]) {
    const r = await cli.query(`DELETE FROM langgraph.${t} WHERE thread_id LIKE '%wa:%'`);
    total += r.rowCount ?? 0;
  }
  await cli.end();
  console.log(`[jobs] reset-wa: ${total} linha(s) removida(s)`);
}

// Entrypoint dos jobs agendados (EventBridge → RunTask com este comando).
// Uso: node dist/jobs.js <retry-dperj|limpeza|health|reset-wa>
const jobs: Record<string, () => Promise<unknown>> = {
  "retry-dperj": processarFila,
  "limpeza": limparConversasInativas,
  "health": avisarSeTokenMorto,
  "reset-wa": resetWhatsApp,
};

async function main() {
  validarEnv();
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
