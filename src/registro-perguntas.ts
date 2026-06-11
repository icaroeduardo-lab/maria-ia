import type { Pergunta } from "./perguntas.js";
import { proxima } from "./perguntas.js";
import type { GraphState } from "./state.js";
import { PERGUNTAS_FAMILIA } from "./services/familia-pensao/graph.js";
import { PERGUNTAS_TRABALHISTA } from "./services/trabalhista/graph.js";
import { PERGUNTAS_INSS } from "./services/inss/graph.js";
import { PERGUNTAS_OUTROS } from "./services/outros/graph.js";
import { PERGUNTAS_PESSOAIS } from "./nodes/coleta/dados-pessoais.js";
import { PERGUNTAS_RESIDENCIAIS } from "./nodes/coleta/dados-residenciais.js";
import { PERGUNTAS_CONTATO } from "./nodes/coleta/dados-contato.js";

// categoria (triagem) → node do grafo principal + perguntas do serviço
const SERVICOS: Record<string, { node: string; perguntas: Pergunta[] }> = {
  familia_pensao: { node: "familia_pensao", perguntas: PERGUNTAS_FAMILIA },
  trabalhista:    { node: "trabalhista",    perguntas: PERGUNTAS_TRABALHISTA },
  inss_federal:   { node: "inss",           perguntas: PERGUNTAS_INSS },
  penal:          { node: "outros",         perguntas: PERGUNTAS_OUTROS },
  outros:         { node: "outros",         perguntas: PERGUNTAS_OUTROS },
};

export function servicoDe(categoria: string) {
  return SERVICOS[categoria] ?? SERVICOS.outros;
}

const GRUPOS_COLETA = [
  { node: "dados_pessoais",     perguntas: PERGUNTAS_PESSOAIS },
  { node: "dados_residenciais", perguntas: PERGUNTAS_RESIDENCIAIS },
  { node: "dados_contato",      perguntas: PERGUNTAS_CONTATO },
];

// chave de coleta → perguntas do mesmo grupo (nome→pessoais, cep→residenciais...)
export function grupoColetaDe(chave: string): Pergunta[] | undefined {
  return GRUPOS_COLETA.find((g) => g.perguntas.some((p) => p.chave === chave))?.perguntas;
}

// chave → Pergunta, todas as perguntas de todos os grupos
export const PERGUNTAS_POR_CHAVE = new Map<string, Pergunta>(
  [
    ...PERGUNTAS_FAMILIA,
    ...PERGUNTAS_TRABALHISTA,
    ...PERGUNTAS_INSS,
    ...PERGUNTAS_OUTROS,
    ...GRUPOS_COLETA.flatMap((g) => g.perguntas),
  ].map((p) => [p.chave, p])
);

// Decide o próximo node: perguntas do serviço → coleta → envio para a DPERJ.
// Usado como conditional edge após `informativo` e após `extrator`.
export function roteador(state: GraphState): string {
  const dados = state.dadosColetados;
  const servico = servicoDe(state.categoria);
  if (proxima(servico.perguntas, dados)) return servico.node;
  for (const grupo of GRUPOS_COLETA) {
    if (proxima(grupo.perguntas, dados)) return grupo.node;
  }
  return "enviar_dados";
}
