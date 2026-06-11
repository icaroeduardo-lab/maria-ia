import "dotenv/config";
import { StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { GraphAnnotation } from "./state.js";
import { saudacao } from "./nodes/onboarding/saudacao.js";
import { lgpd, lgpdProcessar, lgpdRecusado, lgpdRoute } from "./nodes/onboarding/lgpd.js";
import { primeiraMensagem } from "./nodes/onboarding/primeira-mensagem.js";
import { triagem } from "./nodes/atendimento/triagem.js";
import { informativo } from "./nodes/atendimento/informativo.js";
import { extrator } from "./nodes/atendimento/extrator.js";
import { enviarDados } from "./nodes/atendimento/enviar-dados.js";
import { encerramento } from "./nodes/atendimento/encerramento.js";
import { dadosPessoais } from "./nodes/coleta/dados-pessoais.js";
import { dadosResidenciais } from "./nodes/coleta/dados-residenciais.js";
import { dadosContato } from "./nodes/coleta/dados-contato.js";
import { familiaPensaoGraph } from "./services/familia-pensao/graph.js";
import { trabalhistaGraph } from "./services/trabalhista/graph.js";
import { inssGraph } from "./services/inss/graph.js";
import { outrosGraph } from "./services/outros/graph.js";
import { roteador } from "./registro-perguntas.js";

// Postgres quando DATABASE_URL configurada (Fase 5); SQLite como fallback de dev
async function criarCheckpointer(): Promise<BaseCheckpointSaver> {
  if (process.env.DATABASE_URL) {
    const saver = PostgresSaver.fromConnString(process.env.DATABASE_URL);
    await saver.setup();
    return saver;
  }
  return SqliteSaver.fromConnString("./data/checkpoints.db");
}
const checkpointer = await criarCheckpointer();

// Destinos possíveis do roteador (próxima pergunta pendente ou envio à DPERJ)
const DESTINOS_ROTEADOR = {
  familia_pensao:     "familia_pensao",
  trabalhista:        "trabalhista",
  inss:               "inss",
  outros:             "outros",
  dados_pessoais:     "dados_pessoais",
  dados_residenciais: "dados_residenciais",
  dados_contato:      "dados_contato",
  enviar_dados:       "enviar_dados",
} as const;

export const graph = new StateGraph(GraphAnnotation)

  // ── Nodes ──────────────────────────────────────────────────────────────
  .addNode("saudacao",           saudacao)
  .addNode("lgpd",               lgpd)
  .addNode("lgpd_processar",     lgpdProcessar)
  .addNode("lgpd_recusado",      lgpdRecusado)
  .addNode("primeira_mensagem",  primeiraMensagem)
  .addNode("triagem",            triagem)
  .addNode("extrator_inicial",   extrator)
  .addNode("informativo",        informativo)
  .addNode("extrator",           extrator)
  .addNode("familia_pensao",     familiaPensaoGraph)
  .addNode("trabalhista",        trabalhistaGraph)
  .addNode("inss",               inssGraph)
  .addNode("outros",             outrosGraph)
  .addNode("dados_pessoais",     dadosPessoais)
  .addNode("dados_residenciais", dadosResidenciais)
  .addNode("dados_contato",      dadosContato)
  .addNode("enviar_dados",       enviarDados)
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

  // ── Triagem + extração inicial do contexto ─────────────────────────────
  // interruptAfter["primeira_mensagem"] pausa aqui — aguarda descrição do caso
  .addEdge("primeira_mensagem", "triagem")
  .addEdge("triagem", "extrator_inicial")
  .addEdge("extrator_inicial", "informativo")
  .addConditionalEdges("informativo", roteador, DESTINOS_ROTEADOR)

  // ── Loop de perguntas: cada node pergunta 1 item e pausa (interruptAfter)
  //    resposta do usuário → extrator → roteador decide a próxima pergunta ─
  .addEdge("familia_pensao",     "extrator")
  .addEdge("trabalhista",        "extrator")
  .addEdge("inss",               "extrator")
  .addEdge("outros",             "extrator")
  .addEdge("dados_pessoais",     "extrator")
  .addEdge("dados_residenciais", "extrator")
  .addEdge("dados_contato",      "extrator")
  .addConditionalEdges("extrator", roteador, DESTINOS_ROTEADOR)

  // ── Envio à DPERJ + encerramento ───────────────────────────────────────
  .addEdge("enviar_dados", "encerramento")
  .addEdge("encerramento", "__end__")

  .compile({
    checkpointer,
    interruptAfter: [
      "lgpd",
      "primeira_mensagem",
      "familia_pensao",
      "trabalhista",
      "inss",
      "outros",
      "dados_pessoais",
      "dados_residenciais",
      "dados_contato",
    ],
  });
