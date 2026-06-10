import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HumanMessage } from "@langchain/core/messages";
import { graph } from "./graph.js";
import type { GraphAnnotation } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "../public")));

type SessionState = typeof GraphAnnotation.State;
const sessions = new Map<string, SessionState>();

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body as { sessionId: string; message?: string };

  let state: SessionState = sessions.get(sessionId) ?? { messages: [], etapa: "inicio", lgpdAceito: false };

  if (message !== undefined) {
    state = { ...state, messages: [...state.messages, new HumanMessage(message)] };
  }

  const result = await graph.invoke(state);
  sessions.set(sessionId, result);

  const newMessages = result.messages.slice(state.messages.length - (message ? 1 : 0));

  res.json({
    messages: newMessages.map((m) => ({
      role: m.getType(),
      content: m.content,
    })),
    etapa: result.etapa,
    lgpdAceito: result.lgpdAceito,
  });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
