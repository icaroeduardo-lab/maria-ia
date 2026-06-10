import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

// TODO: coletar CEP → Estado → Cidade → Bairro → Logradouro → Número → Complemento
export async function dadosResidenciais(_state: GraphState) {
  return {
    messages: [new AIMessage("[TODO] Dados residenciais — CEP, Endereço, Bairro")],
  };
}
