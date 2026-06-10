import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

// TODO: coletar CPF e Nome em loop, verificar na API se já é cadastrado
export async function dadosPessoais(_state: GraphState) {
  return {
    messages: [new AIMessage("[TODO] Dados pessoais — CPF e Nome")],
  };
}
