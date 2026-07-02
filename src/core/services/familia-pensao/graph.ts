import { StateGraph } from "@langchain/langgraph";
import { GraphAnnotation } from "../../state.js";
import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_FAMILIA: Pergunta[] = [
  {
    chave: "tipo_acao",
    texto: "Sobre o que é o seu caso?",
    obrigatoria: true,
    tipo: "opcoes",
    opcoes: ["Pensão alimentícia", "Guarda dos filhos", "Divórcio", "Reconhecimento de paternidade", "Outro"],
    descricao: "Tipo de ação de família: pensão alimentícia, guarda, divórcio, paternidade ou outro",
  },
  {
    chave: "tem_filhos",
    texto: "Você tem filhos?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se a pessoa tem filhos: 'sim' ou 'não'",
  },
  {
    chave: "filhos_menores",
    texto: "Algum dos seus filhos é menor de 18 anos?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se algum filho é menor de 18 anos: 'sim' ou 'não'",
    condicao: (d) => d.tem_filhos === "sim",
  },
  {
    chave: "quantos_filhos",
    texto: "Quantos filhos você tem?",
    obrigatoria: false,
    tipo: "texto",
    descricao: "Quantidade de filhos (número)",
    condicao: (d) => d.tem_filhos === "sim",
  },
  {
    chave: "nome_outra_parte",
    texto: "Qual o nome completo da outra pessoa envolvida no caso (ex: o pai ou a mãe da criança, o ex-companheiro)?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Nome PRÓPRIO completo da outra parte (ex: 'João da Silva'). Se o usuário só disse 'meu marido', 'o pai', 'minha ex', deixe null",
    validar: (v) =>
      v.trim().split(/\s+/).length >= 2 &&
      !/\b(marido|esposa|esposo|companheir\w*|namorad\w*|pai|mãe|mae|ex)\b/i.test(v),
  },
  {
    chave: "endereco_outra_parte",
    texto: "Você sabe onde essa pessoa mora ou trabalha?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se sabe o endereço ou local de trabalho da outra parte: 'sim' ou 'não'",
  },
  {
    chave: "ja_existe_processo",
    texto: "Já existe algum processo na Justiça sobre esse caso?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se já existe processo judicial sobre o caso: 'sim' ou 'não'",
  },
  {
    chave: "recebe_pensao_atualmente",
    texto: "Atualmente a criança recebe algum valor de pensão, mesmo que informal?",
    obrigatoria: false,
    tipo: "sim_nao",
    descricao: "Se já recebe algum valor de pensão atualmente: 'sim' ou 'não'",
    condicao: (d) => (d.tipo_acao ?? "").toLowerCase().includes("pensão") && d.tem_filhos === "sim",
  },
];

export const familiaPensaoGraph = new StateGraph(GraphAnnotation)
  .addNode("coletar_dados_caso", nodePergunta(PERGUNTAS_FAMILIA))
  .addEdge("__start__", "coletar_dados_caso")
  .addEdge("coletar_dados_caso", "__end__")
  .compile();
