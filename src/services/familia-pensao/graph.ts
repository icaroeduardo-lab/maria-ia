import { AIMessage } from "@langchain/core/messages";
import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "../../state.js";
import type { GraphState } from "../../state.js";

// TODO: adicionar nodes específicos de família/pensão
// Ex: tipo_acao, valor_pensao, filhos, documentos, etc.

async function coletarDadosCaso(_state: GraphState) {
  return {
    messages: [new AIMessage("[TODO] Família/Pensão — perguntas específicas do serviço")],
  };
}

export const familiaPensaoGraph = new StateGraph(GraphAnnotation)
  .addNode("coletar_dados_caso", coletarDadosCaso)
  .addEdge("__start__", "coletar_dados_caso")
  .addEdge("coletar_dados_caso", "__end__")
  .compile();
