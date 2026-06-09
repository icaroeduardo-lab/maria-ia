import { AIMessage } from "@langchain/core/messages";
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
          { type: "options", options: ["Sim", "Não"] },
        ],
      }),
    ],
  };
}

export function lgpdRoute(state: GraphState) {
  const last = state.messages.at(-1);
  const texto = typeof last?.content === "string" ? last.content.toLowerCase().trim() : "";
  const aceitou = texto.includes("sim") || texto === "s";
  return aceitou ? "aceito" : "recusado";
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
