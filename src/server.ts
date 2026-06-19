import "dotenv/config";
import dns from "node:dns";
// prefere IPv4 ao resolver DNS: em redes com IPv6 quebrado, o fetch (undici)
// tenta IPv6 primeiro e estoura ETIMEDOUT (ex: envio à Graph API do WhatsApp).
dns.setDefaultResultOrder("ipv4first");
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
import { limparConversasInativas } from "./limpeza.js";
import { mockRoutes } from "./routes/mock.js";
import { assistidosFlowRoutes } from "./routes/assistidos.js";
import { fichaRoutes } from "./routes/ficha.js";

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
    lgpdAceito: result?.lgpdAceito ?? false,
  };
});

await app.register(whatsappRoutes);
await app.register(authRoutes);
await app.register(adminRoutes, { prefix: "/admin" });
await app.register(mockRoutes);
await app.register(assistidosFlowRoutes);
await app.register(fichaRoutes);

// retry de envios à DPERJ que falharam (fila local em data/fila-envios.db)
setInterval(() => processarFila().catch(console.error), 5 * 60 * 1000).unref();

// expira o estado de conversas inativas (1x ao subir + a cada 24h)
limparConversasInativas().catch(console.error);
setInterval(() => limparConversasInativas().catch(console.error), 24 * 60 * 60 * 1000).unref();

const PORT = Number(process.env.PORT ?? 3000);
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`Servidor em http://localhost:${PORT}`);
