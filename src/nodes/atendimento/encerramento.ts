import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

const RODAPE =
  "Se precisar de ajuda, ligue *129* de segunda a sexta, das 9h às 18h. Até logo! 👋";

// TODO Fase 3: enviar dadosColetados para a API da DPERJ e mostrar o protocolo retornado
export async function encerramento(state: GraphState) {
  const coletouDados = Object.keys(state.dadosColetados).length > 0;

  const texto = coletouDados
    ? "Prontinho! Registrei todas as suas informações e o seu caso já foi encaminhado " +
      "para a equipe da Defensoria. Entraremos em contato pelo telefone informado.\n\n" +
      RODAPE
    : `Atendimento encerrado. ${RODAPE}`;

  return {
    messages: [new AIMessage(texto)],
  };
}
