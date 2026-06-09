import "dotenv/config";
import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "./state.js";
import { saudacao } from "./nodes/saudacao.js";
import { lgpd, lgpdRecusado, lgpdRoute } from "./nodes/lgpd.js";
import { encerramento } from "./nodes/encerramento.js";

export const graph = new StateGraph(GraphAnnotation)
  .addNode("saudacao", saudacao)
  .addNode("lgpd", lgpd)
  .addNode("lgpd_recusado", lgpdRecusado)
  .addNode("encerramento", encerramento)
  .addEdge("__start__", "saudacao")
  .addEdge("saudacao", "lgpd")
  .addConditionalEdges("lgpd", lgpdRoute, {
    aceito: "encerramento",
    recusado: "lgpd_recusado",
  })
  .addEdge("lgpd_recusado", "encerramento")
  .addEdge("encerramento", "__end__")
  .compile();
