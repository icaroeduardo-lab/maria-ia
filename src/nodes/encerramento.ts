import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../state.js";

const TEXTO_ENCERRAMENTO =
  "Atendimento encerrado. Se precisar de ajuda, ligue *129* de segunda a sexta, das 9h às 18h. Até logo! 👋";

export async function encerramento(_state: GraphState) {
  return {
    messages: [new AIMessage(TEXTO_ENCERRAMENTO)],
  };
}
