import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HumanMessage } from "@langchain/core/messages";
import { graph } from "./graph.js";
import { processarFila } from "./dperj.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "../public")));

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body as { sessionId: string; message?: string };
  const config = { configurable: { thread_id: sessionId } };

  const prevState = await graph.getState(config);
  const prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;
  const isResuming = prevLen > 0;

  if (isResuming && message) {
    await graph.updateState(config, { messages: [new HumanMessage(message)] });
  }

  const result = await graph.invoke(isResuming ? null : {}, config);

  const newMessages = result.messages
    .slice(prevLen)
    .filter((m) => m.getType() !== "human");

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
