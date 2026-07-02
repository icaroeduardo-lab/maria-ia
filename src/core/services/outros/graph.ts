import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "../../state.js";
import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_OUTROS: Pergunta[] = [
  {
    chave: "tema_caso",
    texto: "Qual desses temas tem mais a ver com o seu caso?",
    obrigatoria: true,
    tipo: "opcoes",
    opcoes: ["Moradia/Aluguel", "Dívidas/Consumo", "Documentos", "Saúde", "Criminal", "Outro"],
    descricao: "Tema geral do caso: moradia, dívidas/consumo, documentos, saúde, criminal ou outro",
  },
  {
    chave: "urgencia",
    texto: "É uma situação urgente, com prazo curto ou risco imediato (ex: despejo marcado, audiência, pessoa presa)?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se o caso é urgente, com prazo ou risco imediato: 'sim' ou 'não'",
  },
  {
    chave: "ja_existe_processo",
    texto: "Já existe algum processo na Justiça sobre esse caso?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se já existe processo judicial sobre o caso: 'sim' ou 'não'",
  },
  {
    chave: "ja_procurou_defensoria",
    texto: "Você já procurou a Defensoria antes por esse mesmo caso?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se já procurou a Defensoria antes pelo mesmo caso: 'sim' ou 'não'",
  },
];

export const outrosGraph = new StateGraph(GraphAnnotation)
  .addNode("coletar_dados_caso", nodePergunta(PERGUNTAS_OUTROS))
  .addEdge("__start__", "coletar_dados_caso")
  .addEdge("coletar_dados_caso", "__end__")
  .compile();
