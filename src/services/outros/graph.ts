import { AIMessage } from "@langchain/core/messages";
import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "../../state.js";
import type { GraphState } from "../../state.js";

// TODO: adicionar nodes para demandas gerais não categorizadas
// Ex: descricao_detalhada, documentos_necessarios, etc.

async function coletarDadosCaso(_state: GraphState) {
  return {
    messages: [new AIMessage("[TODO] Outros — perguntas específicas do serviço")],
  };
}

export const outrosGraph = new StateGraph(GraphAnnotation)
  .addNode("coletar_dados_caso", coletarDadosCaso)
  .addEdge("__start__", "coletar_dados_caso")
  .addEdge("coletar_dados_caso", "__end__")
  .compile();
