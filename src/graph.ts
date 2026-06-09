import "dotenv/config";
import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "./state.js";
import { saudacao } from "./nodes/saudacao.js";

export const graph = new StateGraph(GraphAnnotation)
  .addNode("saudacao", saudacao)
  .addEdge("__start__", "saudacao")
  .addEdge("saudacao", "__end__")
  .compile();
