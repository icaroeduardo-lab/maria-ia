import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "../../state.js";
import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_TRABALHISTA: Pergunta[] = [
  {
    chave: "situacao_emprego",
    texto: "Qual é a sua situação hoje?",
    obrigatoria: true,
    tipo: "opcoes",
    opcoes: ["Fui demitido(a)", "Ainda trabalho na empresa", "Pedi demissão", "Outra situação"],
    descricao: "Situação atual do vínculo de emprego: demitido, ainda trabalha, pediu demissão ou outra",
  },
  {
    chave: "motivo_reclamacao",
    texto: "Qual é o principal problema?",
    obrigatoria: true,
    tipo: "opcoes",
    opcoes: ["Verbas rescisórias", "Salário atrasado", "Horas extras", "FGTS não depositado", "Assédio", "Acidente de trabalho", "Outro"],
    descricao: "Motivo principal da reclamação trabalhista",
  },
  {
    chave: "carteira_assinada",
    texto: "Você trabalhava com carteira assinada?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se trabalhava com carteira assinada (vínculo CLT registrado): 'sim' ou 'não'",
  },
  {
    chave: "nome_empresa",
    texto: "Qual o nome da empresa onde você trabalha ou trabalhava?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Nome da empresa empregadora",
  },
  {
    chave: "data_inicio_trabalho",
    texto: "Quando você começou a trabalhar nessa empresa? (mês e ano, se lembrar)",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Data ou período em que começou a trabalhar na empresa",
    validar: (v) => /\d/.test(v), // rejeita inferência vaga ("recentemente", "há um tempo")
  },
  {
    chave: "data_saida_trabalho",
    texto: "Quando foi o seu último dia de trabalho?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Data de saída/demissão da empresa",
    condicao: (d) => !(d.situacao_emprego ?? "").toLowerCase().includes("ainda trabalho"),
    validar: (v) => /\d/.test(v),
  },
  {
    chave: "ja_existe_processo",
    texto: "Já existe algum processo na Justiça do Trabalho sobre esse caso?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se já existe processo trabalhista sobre o caso: 'sim' ou 'não'",
  },
];

export const trabalhistaGraph = new StateGraph(GraphAnnotation)
  .addNode("coletar_dados_caso", nodePergunta(PERGUNTAS_TRABALHISTA))
  .addEdge("__start__", "coletar_dados_caso")
  .addEdge("coletar_dados_caso", "__end__")
  .compile();
