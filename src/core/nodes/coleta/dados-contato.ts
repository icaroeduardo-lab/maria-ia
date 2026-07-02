import { nodePergunta, type Pergunta } from "../../perguntas.js";

export const PERGUNTAS_CONTATO: Pergunta[] = [
  {
    chave: "telefone",
    texto: "Qual o seu telefone com DDD? (ex: 21 99999-0000)",
    obrigatoria: true,
    tipo: "telefone",
    descricao: "Telefone de contato com DDD",
  },
  {
    chave: "telefone_whatsapp",
    texto: "Esse número tem WhatsApp?",
    obrigatoria: true,
    tipo: "sim_nao",
    descricao: "Se o telefone informado tem WhatsApp: 'sim' ou 'não'",
  },
  {
    chave: "email",
    texto: "Qual o seu e-mail? Se não tiver, responda \"não tenho\".",
    obrigatoria: false,
    tipo: "texto",
    descricao: "E-mail de contato, se houver",
  },
];

export const dadosContato = nodePergunta(PERGUNTAS_CONTATO);
