import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { processarMensagem } from "./chat.js";
import { whatsappRouter } from "./channels/whatsapp.js";
import { processarFila } from "./dperj.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "../public")));
app.use(whatsappRouter);

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body as { sessionId: string; message?: string };
  const { result, newMessages } = await processarMensagem(sessionId, message, "web");

  res.json({
    messages: newMessages.map((m) => ({
      role: m.getType(),
      content: m.content,
    })),
    lgpdAceito: result.lgpdAceito,
  });
});

// retry de envios à DPERJ que falharam (fila local em data/fila-envios.db)
setInterval(() => processarFila().catch(console.error), 5 * 60 * 1000).unref();

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
