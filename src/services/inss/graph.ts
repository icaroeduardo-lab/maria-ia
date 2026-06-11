import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "../../state.js";
import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_INSS: Pergunta[] = [
  {
    chave: "tipo_beneficio",
    texto: "Qual benefício está relacionado ao seu caso?",
    obrigatoria: true,
    tipo: "opcoes",
    opcoes: ["Aposentadoria", "BPC/LOAS", "Auxílio-doença", "Pensão por morte", "Salário-maternidade", "Outro"],
    descricao: "Tipo de benefício do INSS: aposentadoria, BPC/LOAS, auxílio-doença, pensão por morte, salário-maternidade ou outro",
  },
  {
    chave: "ja_pediu_inss",
    texto: "Você já fez o pedido desse benefício no INSS?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se já solicitou o benefício no INSS: 'sim' ou 'não'",
  },
  {
    chave: "beneficio_negado",
    texto: "O pedido foi negado ou o benefício foi cortado pelo INSS?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se o benefício foi negado, suspenso ou cortado pelo INSS: 'sim' ou 'não'",
    condicao: (d) => d.ja_pediu_inss === "sim",
  },
  {
    chave: "numero_beneficio",
    texto: "Você tem o número do benefício ou do protocolo do INSS? Se tiver, me informe. Se não, responda \"não tenho\".",
    obrigatoria: false,
    tipo: "texto",
    descricao: "Número do benefício (NB) ou protocolo do INSS, se houver",
    condicao: (d) => d.ja_pediu_inss === "sim",
  },
  {
    chave: "recebe_outro_beneficio",
    texto: "Você ou alguém da sua casa recebe algum outro benefício do governo (ex: Bolsa Família, BPC)?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se a pessoa ou alguém da família recebe outro benefício do governo: 'sim' ou 'não'",
  },
];

export const inssGraph = new StateGraph(GraphAnnotation)
  .addNode("coletar_dados_caso", nodePergunta(PERGUNTAS_INSS))
  .addEdge("__start__", "coletar_dados_caso")
  .addEdge("coletar_dados_caso", "__end__")
  .compile();
