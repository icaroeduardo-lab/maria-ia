import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

// TODO: coletar Telefone → confirmar WhatsApp → Email
export async function dadosContato(_state: GraphState) {
  return {
    messages: [new AIMessage("[TODO] Dados de contato — Telefone e E-mail")],
  };
}
