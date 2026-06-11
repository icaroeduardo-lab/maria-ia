import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph } from "./graph.js";

// Processa uma mensagem de qualquer canal (web ou whatsapp), preservando o
// padrão crítico de multi-turn: thread novo → invoke(estado inicial);
// resume → updateState + invoke(null). NUNCA invoke(input não-nulo) em thread existente.
export async function processarMensagem(sessionId: string, message: string | undefined, canal: "web" | "whatsapp") {
  const config = { configurable: { thread_id: sessionId } };

  const prevState = await graph.getState(config);
  const prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;
  const isResuming = prevLen > 0;

  if (isResuming && message) {
    await graph.updateState(config, { messages: [new HumanMessage(message)] });
  }

  const result = await graph.invoke(isResuming ? null : { canal }, config);

  const newMessages = (result.messages as BaseMessage[])
    .slice(prevLen)
    .filter((m) => m.getType() !== "human");

  return { result, newMessages };
}
