import "dotenv/config";
import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "./state.js";
import { saudacao } from "./nodes/saudacao.js";
import { lgpd, lgpdProcessar, lgpdRecusado, lgpdRoute } from "./nodes/lgpd.js";
import { primeiraMensagem } from "./nodes/primeira-mensagem.js";
import { triagem, triagemRoute } from "./nodes/triagem.js";
import { informativo } from "./nodes/informativo.js";
import { encerramento } from "./nodes/encerramento.js";

function routeStart(state: typeof GraphAnnotation.State) {
  switch (state.etapa) {
    case "aguardando_lgpd":    return "lgpd_processar";
    case "aguardando_caso":    return "triagem";
    case "triagem_concluida":  return "informativo";
    default:                   return "saudacao";
  }
}

const CATEGORIAS = ["trabalhista", "inss_federal", "familia_pensao", "penal", "outros"] as const;

export const graph = new StateGraph(GraphAnnotation)
  .addNode("saudacao", saudacao)
  .addNode("lgpd", lgpd)
  .addNode("lgpd_processar", lgpdProcessar)
  .addNode("lgpd_recusado", lgpdRecusado)
  .addNode("primeira_mensagem", primeiraMensagem)
  .addNode("triagem", triagem)
  .addNode("informativo", informativo)
  .addNode("encerramento", encerramento)
  .addConditionalEdges("__start__", routeStart)
  .addEdge("saudacao", "lgpd")
  .addEdge("lgpd", "__end__")
  .addConditionalEdges("lgpd_processar", lgpdRoute, {
    primeira_mensagem: "primeira_mensagem",
    lgpd_recusado: "lgpd_recusado",
  })
  .addEdge("lgpd_recusado", "encerramento")
  .addEdge("primeira_mensagem", "__end__")
  .addConditionalEdges("triagem", triagemRoute, Object.fromEntries(
    CATEGORIAS.map((c) => [c, "informativo"])
  ))
  .addEdge("informativo", "encerramento")
  .addEdge("encerramento", "__end__")
  .compile();
