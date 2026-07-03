import "dotenv/config";
import dns from "node:dns";
// prefere IPv4 ao resolver DNS: em redes com IPv6 quebrado, o fetch (undici)
// tenta IPv6 primeiro e estoura ETIMEDOUT (ex: envio à Graph API do WhatsApp).
dns.setDefaultResultOrder("ipv4first");
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { existsSync } from "node:fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { processarMensagem } from "../core/chat.js";
import { whatsappRoutes } from "../core/channels/whatsapp.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { processarFila } from "../core/dperj.js";
import { limparConversasInativas } from "../core/limpeza.js";
import { verificarDb, verificarTokenWhatsApp, avisarSeTokenMorto } from "../core/health.js";
import { prisma } from "../core/db.js";
import { validarFlow } from "../core/engine/validar.js";
import type { FlowNode, FlowEdge } from "../core/engine/builder.js";
import { mockRoutes } from "./routes/mock.js";
import { assistidosFlowRoutes } from "./routes/assistidos.js";
import { fichaRoutes } from "./routes/ficha.js";
import { kycRoutes } from "./routes/kyc.js";
import { processosRoutes } from "./routes/processos.js";
import { filaConfigurada } from "../core/queue.js";
import { env, validarEnv } from "../core/env.js";

validarEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify();

await app.register(fastifyCors, { origin: true });
await app.register(fastifyJwt, { secret: env.jwtSecret() });
await app.register(fastifyStatic, { root: join(__dirname, "../../public") });

// Documentação da API: serve docs/openapi.yaml (fonte da verdade, mantida à mão)
// no Swagger UI em /docs. Sem o arquivo (ex: imagem antiga), o server sobe normal.
const openapiPath = join(__dirname, "../../docs/openapi.yaml");
if (existsSync(openapiPath)) {
  await app.register(fastifySwagger, {
    mode: "static",
    specification: { path: openapiPath, baseDir: dirname(openapiPath) },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
} else {
  console.warn("[docs] docs/openapi.yaml não encontrado — /docs desabilitado");
}

app.post("/api/chat", async (req) => {
  const { sessionId, message } = req.body as { sessionId: string; message?: string };
  const { result, newMessages } = await processarMensagem(sessionId, message, "web");

  return {
    messages: newMessages.map((m) => ({
      role: m.getType(),
      content: m.content,
    })),
    lgpdAceito: result?.lgpdAceito ?? false,
  };
});

// healthcheck: DB + validade do token WhatsApp (503 se algo crítico degradado)
app.get("/health", async (_req, reply) => {
  const [db, token] = await Promise.all([verificarDb(), verificarTokenWhatsApp()]);
  const ok = db && token !== false; // token null (não configurado) não derruba
  return reply.code(ok ? 200 : 503).send({
    ok,
    db: db ? "ok" : "erro",
    whatsappToken: token === null ? "nao_configurado" : token ? "ok" : "invalido",
  });
});

await app.register(whatsappRoutes);
await app.register(authRoutes);
await app.register(adminRoutes, { prefix: "/admin" });
await app.register(mockRoutes);
await app.register(assistidosFlowRoutes);
await app.register(fichaRoutes);
await app.register(kycRoutes);
await app.register(processosRoutes);

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
