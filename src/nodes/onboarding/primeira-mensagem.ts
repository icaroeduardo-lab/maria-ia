import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";


export async function primeiraMensagem(_state: GraphState) {
  return {
    messages: [
      new AIMessage("Me conte um pouco sobre o seu caso."),
    ],
  };
}
