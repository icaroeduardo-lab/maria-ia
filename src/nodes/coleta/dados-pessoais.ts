import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_PESSOAIS: Pergunta[] = [
  {
    chave: "nome",
    texto: "Agora preciso de alguns dados seus. Qual o seu nome completo?",
    obrigatoria: true,
    tipo: "texto",
    descricao: "Nome completo da pessoa atendida",
  },
  {
    chave: "cpf",
    texto: "Qual o seu CPF? (só os números)",
    obrigatoria: true,
    tipo: "cpf",
    descricao: "CPF da pessoa atendida (11 dígitos)",
  },
  {
    chave: "data_nascimento",
    texto: "Qual a sua data de nascimento? (ex: 05/03/1985)",
    obrigatoria: true,
    tipo: "data",
    descricao: "Data de nascimento da pessoa atendida",
  },
];

// TODO Fase 3: verificar na API da DPERJ se o CPF já é cadastrado
export const dadosPessoais = nodePergunta(PERGUNTAS_PESSOAIS);
