import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import fastifyJwt from "@fastify/jwt";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { processarMensagem } from "./chat.js";
import { whatsappRoutes } from "./channels/whatsapp.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { processarFila } from "./dperj.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = Fastify();

await app.register(fastifyCors, { origin: true });
await app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? "dev-secret-trocar-em-producao" });
await app.register(fastifyStatic, { root: join(__dirname, "../public") });

app.post("/api/chat", async (req) => {
  const { sessionId, message } = req.body as { sessionId: string; message?: string };
  const { result, newMessages } = await processarMensagem(sessionId, message, "web");

  return {
    messages: newMessages.map((m) => ({
      role: m.getType(),
      content: m.content,
    })),
    lgpdAceito: result.lgpdAceito,
  };
});

await app.register(whatsappRoutes);
await app.register(authRoutes);
await app.register(adminRoutes, { prefix: "/admin" });

// retry de envios à DPERJ que falharam (fila local em data/fila-envios.db)
setInterval(() => processarFila().catch(console.error), 5 * 60 * 1000).unref();

const PORT = Number(process.env.PORT ?? 3000);
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`Servidor em http://localhost:${PORT}`);
