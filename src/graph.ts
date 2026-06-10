import "dotenv/config";
import { StateGraph, MemorySaver } from "@langchain/langgraph";
import { GraphAnnotation } from "./state.js";
import { saudacao } from "./nodes/onboarding/saudacao.js";
import { lgpd, lgpdProcessar, lgpdRecusado, lgpdRoute } from "./nodes/onboarding/lgpd.js";
import { primeiraMensagem } from "./nodes/onboarding/primeira-mensagem.js";
import { triagem, triagemRoute } from "./nodes/atendimento/triagem.js";
import { informativo } from "./nodes/atendimento/informativo.js";
import { encerramento } from "./nodes/atendimento/encerramento.js";
import { dadosPessoais } from "./nodes/coleta/dados-pessoais.js";
import { dadosResidenciais } from "./nodes/coleta/dados-residenciais.js";
import { dadosContato } from "./nodes/coleta/dados-contato.js";
import { familiaPensaoGraph } from "./services/familia-pensao/graph.js";
import { trabalhistaGraph } from "./services/trabalhista/graph.js";
import { inssGraph } from "./services/inss/graph.js";
import { outrosGraph } from "./services/outros/graph.js";

const checkpointer = new MemorySaver();

export const graph = new StateGraph(GraphAnnotation)

  // ── Nodes ──────────────────────────────────────────────────────────────
  .addNode("saudacao",           saudacao)
  .addNode("lgpd",               lgpd)
  .addNode("lgpd_processar",     lgpdProcessar)
  .addNode("lgpd_recusado",      lgpdRecusado)
  .addNode("primeira_mensagem",  primeiraMensagem)
  .addNode("triagem",            triagem)
  .addNode("informativo",        informativo)
  .addNode("familia_pensao",     familiaPensaoGraph)
  .addNode("trabalhista",        trabalhistaGraph)
  .addNode("inss",               inssGraph)
  .addNode("outros",             outrosGraph)
  .addNode("dados_pessoais",     dadosPessoais)
  .addNode("dados_residenciais", dadosResidenciais)
  .addNode("dados_contato",      dadosContato)
  .addNode("encerramento",       encerramento)

  // ── Entrada ────────────────────────────────────────────────────────────
  .addEdge("__start__", "saudacao")

  // ── Boas-vindas + LGPD ─────────────────────────────────────────────────
  .addEdge("saudacao", "lgpd")
  // interruptAfter["lgpd"] pausa aqui — aguarda resposta do usuário
  .addEdge("lgpd", "lgpd_processar")
  .addConditionalEdges("lgpd_processar", lgpdRoute, {
    primeira_mensagem: "primeira_mensagem",
    lgpd_recusado:     "lgpd_recusado",
  })
  .addEdge("lgpd_recusado", "encerramento")

  // ── Triagem ────────────────────────────────────────────────────────────
  // interruptAfter["primeira_mensagem"] pausa aqui — aguarda descrição do caso
  .addEdge("primeira_mensagem", "triagem")
  .addConditionalEdges("triagem", triagemRoute, {
    familia_pensao: "informativo",
    trabalhista:    "informativo",
    inss_federal:   "informativo",
    penal:          "informativo",
    outros:         "informativo",
  })
  .addConditionalEdges("informativo", (state) => state.categoria, {
    familia_pensao: "familia_pensao",
    trabalhista:    "trabalhista",
    inss_federal:   "inss",
    penal:          "outros",
    outros:         "outros",
  })

  // ── Subgrafos → coleta de dados ────────────────────────────────────────
  .addEdge("familia_pensao", "dados_pessoais")
  .addEdge("trabalhista",    "dados_pessoais")
  .addEdge("inss",           "dados_pessoais")
  .addEdge("outros",         "dados_pessoais")

  // ── Coleta sequencial — cada node pausa via interruptAfter ─────────────
  .addEdge("dados_pessoais",    "dados_residenciais")
  .addEdge("dados_residenciais","dados_contato")
  .addEdge("dados_contato",     "encerramento")

  .addEdge("encerramento", "__end__")

  .compile({
    checkpointer,
    interruptAfter: [
      "lgpd",
      "primeira_mensagem",
      "dados_pessoais",
      "dados_residenciais",
      "dados_contato",
    ],
  });
