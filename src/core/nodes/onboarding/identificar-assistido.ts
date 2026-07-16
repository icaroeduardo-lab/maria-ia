import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";
import { prisma } from "../../db.js";
import { nodePergunta, proxima, type Pergunta } from "../../perguntas.js";
import { PERGUNTAS_PESSOAIS } from "../coleta/dados-pessoais.js";
import { PERGUNTAS_RESIDENCIAIS } from "../coleta/dados-residenciais.js";
import { PERGUNTAS_CONTATO } from "../coleta/dados-contato.js";

// Identificação real do assistido (Coilab #20260133, Fase 1 — sem API da
// DPERJ, só o Postgres já existente). Fica entre lgpd_processar e
// primeira_mensagem: pergunta o CPF, consulta/cadastra em Assistido, e
// popula dadosColetados com as MESMAS chaves que dados-pessoais.ts /
// dados-residenciais.ts / dados-contato.ts esperam — o skip-gate já
// existente em perguntas.ts (`pendentes()`) cuida de não repetir essas
// perguntas mais tarde. Zero capacidade nova de engine.

const so_digitos = (s: string) => s.replace(/\D/g, "");

function textoUltimaResposta(state: GraphState): string {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  return typeof lastHuman?.content === "string" ? lastHuman.content.trim() : "";
}

function ultimaRespostaSimNao(state: GraphState): boolean {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  return lastHuman?.content === "true";
}

// ── 1. Pergunta o CPF ────────────────────────────────────────────────────

export async function identificarAssistido(_state: GraphState) {
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "text", text: "Antes de começar, preciso confirmar seu cadastro. Qual o seu CPF? (só números)" },
        ],
      }),
    ],
  };
}

// ── 2. Captura o CPF e consulta o Assistido ─────────────────────────────
// Nunca loga o CPF em texto puro (LGPD) — só o resultado (encontrado ou não).

export async function identificarAssistidoLookup(state: GraphState) {
  const cpf = so_digitos(textoUltimaResposta(state));
  if (cpf.length !== 11) return {}; // inválido: nada persiste, a rota decide re-perguntar

  if (!prisma) {
    // sem Postgres configurado: segue sem identificar (degrade gracioso, como o resto do repo)
    return { dadosColetados: { cpf } };
  }

  const existente = await prisma.assistido.findUnique({ where: { cpf } });
  console.log(`[identificar-assistido] CPF verificado — ${existente ? "encontrado" : "não cadastrado"}`);
  return { dadosColetados: { cpf }, assistidoCandidatoId: existente?.id ?? "" };
}

export function identificarAssistidoLookupRoute(state: GraphState): "encontrado" | "novo" | "invalido" {
  if (so_digitos(textoUltimaResposta(state)).length !== 11) return "invalido";
  return state.assistidoCandidatoId ? "encontrado" : "novo";
}

export async function identificarAssistidoInvalido(_state: GraphState) {
  return {
    messages: [new AIMessage("Esse CPF não parece válido. Pode me enviar só os números (11 dígitos)?")],
  };
}

// ── 3a. Encontrado: confirma o nome ─────────────────────────────────────

export async function identificarAssistidoConfirmar(state: GraphState) {
  const candidato =
    prisma && state.assistidoCandidatoId
      ? await prisma.assistido.findUnique({ where: { id: state.assistidoCandidatoId } })
      : null;
  const nome = candidato?.nome ?? "";
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "text", text: `Encontrei seu cadastro! Você é *${nome}*?` },
          { type: "boolean", trueLabel: true, falseLabel: false },
        ],
      }),
    ],
  };
}

export function identificarAssistidoConfirmarRoute(state: GraphState): "sim" | "nao" {
  return ultimaRespostaSimNao(state) ? "sim" : "nao";
}

// "sim": popula dadosColetados com os dados já cadastrados (skip-gate cobre o
// resto do fluxo). data_nascimento só entra se já preenchido no cadastro —
// senão fica pendente e dados-pessoais.ts pergunta normalmente mais tarde.
export async function identificarAssistidoUsarCadastro(state: GraphState) {
  const a =
    prisma && state.assistidoCandidatoId
      ? await prisma.assistido.findUnique({ where: { id: state.assistidoCandidatoId } })
      : null;
  if (!a) return {};

  const dados: Record<string, string> = { nome: a.nome, cpf: a.cpf };
  if (a.dataNascimento) dados.data_nascimento = a.dataNascimento;
  if (a.cep) dados.cep = a.cep;
  if (a.municipio) dados.cidade = a.municipio;
  if (a.bairro) dados.bairro = a.bairro;
  if (a.logradouro) dados.rua = a.logradouro;
  if (a.numero) dados.numero = a.numero;
  if (a.telefone) dados.telefone = a.telefone;
  if (a.email) dados.email = a.email;
  // telefone_whatsapp não tem campo equivalente em Assistido — já sabemos a
  // resposta quando o canal é WhatsApp; no canal web, dados-contato.ts pergunta normal.
  if (state.canal === "whatsapp") dados.telefone_whatsapp = "sim";

  return { dadosColetados: dados, assistidoId: a.id };
}

// ── 3b. Não encontrado: oferece cadastro ────────────────────────────────

export async function identificarAssistidoOferecerCadastro(_state: GraphState) {
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "text", text: "Não encontrei nenhum cadastro com esse CPF. Posso fazer seu cadastro agora?" },
          { type: "boolean", trueLabel: true, falseLabel: false },
        ],
      }),
    ],
  };
}

export function identificarAssistidoOfertaRoute(state: GraphState): "sim" | "nao" {
  return ultimaRespostaSimNao(state) ? "sim" : "nao";
}

// ── 4. Cascata de cadastro (nome + endereço + telefone + email) ────────
// Mesmo padrão de pergunta-texto simples já usado em dados-residenciais.ts
// (sem node de opções dinâmicas — isso é outro card, #20260138, fora de
// escopo aqui). Reaproveita as MESMAS perguntas dos nodes de coleta tardia
// (mesma chave, mesmo texto) — evita duplicar conteúdo e mantém a
// consistência caso o texto de uma pergunta mude.
export const PERGUNTAS_CADASTRO_ASSISTIDO: Pergunta[] = [
  ...PERGUNTAS_PESSOAIS.filter((p) => p.chave === "nome"),
  ...PERGUNTAS_RESIDENCIAIS,
  ...PERGUNTAS_CONTATO.filter((p) => p.chave === "telefone" || p.chave === "email"),
];

// Loop de pergunta próprio (ask → interrupt → captura → próxima ou salvar),
// autocontido — não passa pelo `extrator`/`roteador` compartilhados (evita
// disparar o extrator com LLM/Bedrock nesta fase e evita a checagem de
// PERGUNTAS_CADASTRO_ASSISTIDO vazar para o roteamento normal do serviço).
export const identificarAssistidoCadastrarPerguntar = nodePergunta(PERGUNTAS_CADASTRO_ASSISTIDO);

// Captura simples (sem LLM): todas as perguntas da cascata são texto/cep/telefone
// livre — não há sim/não nem opções aqui, então guardar a resposta bruta basta.
export async function identificarAssistidoCadastrarCapturar(state: GraphState) {
  const chave = state.ultimaPergunta;
  const msg = textoUltimaResposta(state);
  if (!chave || !msg) return {};
  return { dadosColetados: { [chave]: msg } };
}

export function identificarAssistidoCadastrarRoute(state: GraphState): "proxima" | "completo" {
  return proxima(PERGUNTAS_CADASTRO_ASSISTIDO, state.dadosColetados) ? "proxima" : "completo";
}

// ── 5. Salva no banco (create ou update — CPF pode já existir se o nome não
// bateu na confirmação e o assistido optou por recadastrar) ────────────────
export async function identificarAssistidoSalvar(state: GraphState) {
  const cpf = state.dadosColetados.cpf;
  if (!prisma || !cpf) {
    // sem banco: segue sem persistir, mas ainda auto-preenche telefone_whatsapp
    return state.canal === "whatsapp" ? { dadosColetados: { telefone_whatsapp: "sim" } } : {};
  }

  const campos = {
    nome: state.dadosColetados.nome ?? "",
    cep: state.dadosColetados.cep,
    municipio: state.dadosColetados.cidade,
    bairro: state.dadosColetados.bairro,
    logradouro: state.dadosColetados.rua,
    numero: state.dadosColetados.numero,
    telefone: state.dadosColetados.telefone,
    email: state.dadosColetados.email,
  };

  const existente = await prisma.assistido.findUnique({ where: { cpf } });
  const registro = existente
    ? await prisma.assistido.update({ where: { cpf }, data: campos })
    : await prisma.assistido.create({ data: { cpf, ...campos } });
  console.log(`[identificar-assistido] cadastro ${existente ? "atualizado" : "criado"}`);

  const dadosColetados: Record<string, string> = {};
  if (state.canal === "whatsapp") dadosColetados.telefone_whatsapp = "sim";

  return { assistidoId: registro.id, dadosColetados };
}
