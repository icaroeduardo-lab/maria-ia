import "dotenv/config";
import dns from "node:dns";
// prefere IPv4 ao resolver DNS: em redes com IPv6 quebrado, o fetch (undici)
// tenta IPv6 primeiro e estoura ETIMEDOUT (ex: envio à Graph API do WhatsApp).
dns.setDefaultResultOrder("ipv4first");
import { montarApp } from "./app.js";
import { processarFila } from "../core/dperj.js";
import { limparConversasInativas } from "../core/limpeza.js";
import { avisarSeTokenMorto } from "../core/health.js";
import { prisma } from "../core/db.js";
import { validarFlow } from "../core/engine/validar.js";
import type { FlowNode, FlowEdge } from "../core/engine/builder.js";
import { filaConfigurada } from "../core/queue.js";
import { env, validarEnv } from "../core/env.js";

validarEnv();

const app = await montarApp();

// Jobs de fundo (retry DPERJ, limpeza, health do token): na arquitetura v2 são
// disparados pelo EventBridge (ver src/jobs.ts). Em modo dev/monolito (sem fila)
// rodam aqui via setInterval, como antes.
if (!filaConfigurada()) {
  setInterval(() => processarFila().catch(console.error), 5 * 60 * 1000).unref();

  limparConversasInativas().catch(console.error);
  setInterval(() => limparConversasInativas().catch(console.error), 24 * 60 * 60 * 1000).unref();

  avisarSeTokenMorto().catch(console.error);
  setInterval(() => avisarSeTokenMorto().catch(console.error), 6 * 60 * 60 * 1000).unref();
}

// valida o fluxo ativo no boot e loga problemas (não bloqueia o subir)
(async () => {
  if (!prisma) return;
  const ativo = await prisma.flow.findFirst({ where: { active: true } });
  if (!ativo) return;
  const r = validarFlow(ativo.nodes as unknown as FlowNode[], ativo.edges as unknown as FlowEdge[]);
  if (r.erros.length) console.error(`[flow] ⚠️ fluxo ativo "${ativo.name}" com ERROS:`, r.erros);
  if (r.avisos.length) console.warn(`[flow] avisos no fluxo ativo "${ativo.name}":`, r.avisos);
  if (r.ok) console.log(`[flow] fluxo ativo "${ativo.name}" válido ✓`);
})().catch(console.error);

const PORT = env.port();
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`Servidor em http://localhost:${PORT}`);
