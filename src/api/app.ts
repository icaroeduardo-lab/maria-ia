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
import { verificarDb, verificarTokenWhatsApp } from "../core/health.js";
import { mockRoutes } from "./routes/mock.js";
import { assistidosFlowRoutes } from "./routes/assistidos.js";
import { pessoaPresaFlowRoutes } from "./routes/pessoa-presa.js";
import { plantaoFlowRoutes } from "./routes/plantao.js";
import { recessoFlowRoutes } from "./routes/recesso.js";
import { fichaRoutes } from "./routes/ficha.js";
import { kycRoutes } from "./routes/kyc.js";
import { processosRoutes } from "./routes/processos.js";
import { uploadDocumentoRoutes } from "./routes/upload-documento.js";
import { env } from "../core/env.js";

// Monta a app Fastify com todas as rotas registradas, SEM listen e sem jobs de
// fundo (isso fica no server.ts). Separado para os testes poderem inspecionar
// as rotas (ex: guard de sincronia com docs/openapi.yaml) sem subir servidor.

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MontarAppOpts {
  // chamado a cada rota registrada — usado pelo guard de sincronia com o openapi.yaml
  aoRegistrarRota?: (method: string, url: string) => void;
}

export async function montarApp(opts: MontarAppOpts = {}) {
  const app = Fastify();

  if (opts.aoRegistrarRota) {
    app.addHook("onRoute", (r) => {
      const metodos = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of metodos) opts.aoRegistrarRota!(m, r.url);
    });
  }

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

  // healthcheck do ALB: 503 SÓ com dependência vital fora (DB). Token do
  // WhatsApp inválido é degradação do CANAL, não morte da API — reportado no
  // corpo (e nos logs via avisarSeTokenMorto), sem derrubar painel/fluxos.
  // Histórico: token de demo expirado (24h) derrubava a API em loop (#42).
  app.get("/health", async (_req, reply) => {
    const [db, token] = await Promise.all([verificarDb(), verificarTokenWhatsApp()]);
    return reply.code(db ? 200 : 503).send({
      ok: db,
      db: db ? "ok" : "erro",
      whatsappToken: token === null ? "nao_configurado" : token ? "ok" : "invalido",
    });
  });

  await app.register(whatsappRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(mockRoutes);
  await app.register(assistidosFlowRoutes);
  await app.register(pessoaPresaFlowRoutes);
  await app.register(plantaoFlowRoutes);
  await app.register(recessoFlowRoutes);
  await app.register(fichaRoutes);
  await app.register(kycRoutes);
  await app.register(processosRoutes);
  await app.register(uploadDocumentoRoutes);

  return app;
}
