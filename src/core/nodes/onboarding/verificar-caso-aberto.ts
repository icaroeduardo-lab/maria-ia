import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";
import { prisma } from "../../db.js";

// Depois de identificar/cadastrar o assistido (identificar-assistido.ts),
// verifica se ele já tem um Caso "aberto" — se tiver, pergunta se é sobre
// esse assunto antes de repetir a triagem (issue #86).

// verificarCasoAberto NUNCA entra em interruptAfter diretamente: só faz
// sentido pausar quando de fato existe uma pergunta pra responder. Por isso
// ele roteia condicionalmente para um node "aguardar" (que só existe pra
// servir de âncora de interrupt) quando há caso, ou direto pra
// primeira_mensagem quando não há — mesmo princípio do skip-gate de
// nodePergunta(), só que sem passar pelo helper genérico (aqui a decisão
// depende de uma consulta ao banco, não de dadosColetados).
export async function verificarCasoAberto(state: GraphState) {
  if (!prisma || !state.assistidoId) return { casoAbertoTipo: "" };

  const casos = await prisma.caso.findMany({
    where: { assistidoId: state.assistidoId, status: "aberto" },
    orderBy: { criadoEm: "desc" },
  });
  if (!casos.length) return { casoAbertoTipo: "" };

  const caso = casos[0];
  return {
    casoAbertoTipo: caso.tipo,
    messages: [
      new AIMessage({
        content: [
          {
            type: "text",
            text: `Vi que você tem um caso em andamento sobre *${caso.tipo}* (protocolo ${caso.identificador}) — é sobre isso ou é outro assunto?`,
          },
          { type: "boolean", trueLabel: true, falseLabel: false },
        ],
      }),
    ],
  };
}

export function verificarCasoAbertoDispatch(state: GraphState): "aguardar" | "sem_caso" {
  return state.casoAbertoTipo ? "aguardar" : "sem_caso";
}

// Node âncora: não faz nada, só existe pra ficar em interruptAfter (a
// mensagem já foi anexada por verificarCasoAberto no mesmo super-step —
// LangGraph acumula o state.messages antes do interrupt disparar).
export async function verificarCasoAbertoAguardar(_state: GraphState) {
  return {};
}

export function verificarCasoAbertoRoute(state: GraphState): "confirmado" | "outro_assunto" {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  return lastHuman?.content === "true" ? "confirmado" : "outro_assunto";
}

// Mapeamento heurístico de Caso.tipo (string livre, cadastrada manualmente
// hoje pelo painel admin) para a categoria fixa da triagem
// (familia_pensao|trabalhista|inss_federal|penal|outros, ver triagem.ts).
// Não há garantia de correspondência direta — palavras-chave em pt-BR cobrem
// os tipos mais comuns hoje (ex: "Pensão alimentícia", "Divórcio"); tipo sem
// correspondência cai em "outros" (mesmo fallback que a triagem por IA já
// usa quando não reconhece a resposta do modelo).
export function mapearTipoParaCategoria(tipo: string): string {
  const t = tipo.toLowerCase();
  if (/pens[ãa]o|alimen|div[óo]rcio|guarda|fam[íi]lia/.test(t)) return "familia_pensao";
  if (/trabalh|emprego|rescis[ãa]o|carteira/.test(t)) return "trabalhista";
  if (/inss|aposentad|benef[íi]cio|federal/.test(t)) return "inss_federal";
  if (/penal|crime|criminal/.test(t)) return "penal";
  return "outros";
}

// "sim, é sobre esse caso": não repete a triagem — define a categoria pelo
// tipo do Caso e segue direto pro roteador (mesma função usada após
// informativo/extrator) pra pegar a próxima pergunta pendente do serviço.
export async function casoConfirmado(state: GraphState) {
  return { categoria: mapearTipoParaCategoria(state.casoAbertoTipo) };
}
