import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_RESIDENCIAIS: Pergunta[] = [
  {
    chave: "cep",
    texto: "Qual o CEP da sua casa? Se não souber, responda \"não sei\".",
    obrigatoria: false,
    tipo: "cep",
    descricao: "CEP da residência (8 dígitos)",
  },
  {
    chave: "cidade",
    texto: "Em qual cidade você mora?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Cidade onde a pessoa mora",
  },
  {
    chave: "bairro",
    texto: "Qual o seu bairro?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Bairro onde a pessoa mora",
  },
  {
    chave: "rua",
    texto: "Qual o nome da sua rua?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Rua/logradouro onde a pessoa mora",
  },
  {
    chave: "numero",
    texto: "Qual o número da sua casa ou prédio?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Número da residência",
  },
];

// TODO Fase 3: consultar ViaCEP para preencher cidade/bairro/rua a partir do CEP
export const dadosResidenciais = nodePergunta(PERGUNTAS_RESIDENCIAIS);
