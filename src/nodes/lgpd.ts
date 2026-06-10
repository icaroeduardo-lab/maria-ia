import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { GraphState } from "../state.js";

const TEXTO_LGPD =
  "Antes de continuar, preciso que você aceite nosso *Termo de Privacidade*.\n\n" +
  "📄 Acesse: https://defensoria.rj.def.br/politica-de-privacidade\n\n" +
  "Você aceita os termos?";

export async function lgpd(_state: GraphState) {
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "text", text: TEXTO_LGPD },
          { type: "boolean", trueLabel: true, falseLabel: false },
        ],
      }),
    ],
  };
}

export async function lgpdProcessar(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  return { lgpdAceito: lastHuman?.content === "true" };
}

export function lgpdRoute(state: GraphState) {
  return state.lgpdAceito ? "primeira_mensagem" : "lgpd_recusado";
}

export async function lgpdRecusado(_state: GraphState) {
  return {
    messages: [
      new AIMessage(
        "Tudo bem. Sem o aceite não é possível continuar o atendimento."
      ),
    ],
  };
}
