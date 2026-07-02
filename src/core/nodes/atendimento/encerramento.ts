import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

const RODAPE =
  "Se precisar de ajuda, ligue *129* de segunda a sexta, das 9h às 18h. Até logo! 👋";

export async function encerramento(state: GraphState) {
  const coletouDados = Object.keys(state.dadosColetados).length > 0;

  let texto: string;
  if (state.protocolo) {
    texto =
      `Prontinho! Seu atendimento foi registrado com o protocolo *${state.protocolo}*. ` +
      "Guarde esse número. A equipe da Defensoria vai entrar em contato pelo telefone informado.\n\n" +
      RODAPE;
  } else if (coletouDados) {
    // envio à DPERJ falhou — payload está na fila de retry, protocolo sai depois
    texto =
      "Prontinho! Registrei todas as suas informações e o seu caso será encaminhado " +
      "para a equipe da Defensoria, que vai entrar em contato pelo telefone informado.\n\n" +
      RODAPE;
  } else {
    texto = `Atendimento encerrado. ${RODAPE}`;
  }

  return {
    messages: [new AIMessage(texto)],
  };
}
