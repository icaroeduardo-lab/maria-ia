import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../state.js";

const MENSAGENS: Record<string, string> = {
  trabalhista:
    "A DPERJ não realiza atendimento em casos da Justiça do Trabalho.\n\n" +
    "Procure o *sindicato da sua categoria* ou o *Ministério Público do Trabalho*.",
  inss_federal:
    "A DPERJ não realiza atendimento em casos da Justiça Federal.\n\n" +
    "Para assuntos de INSS ou Caixa Econômica, procure a *DPU* em: www.dpu.def.br",
  familia_pensao:
    "Entendemos que você precisa de ajuda com questões de família ou pensão.\n\n" +
    "Em breve teremos atendimento disponível para esse tipo de demanda.",
  penal:
    "Entendemos que você precisa de ajuda com questões criminais.\n\n" +
    "Em breve teremos atendimento disponível para esse tipo de demanda.",
  outros:
    "Entendemos sua solicitação.\n\n" +
    "Em breve teremos atendimento disponível para esse tipo de demanda.",
};

export async function informativo(state: GraphState) {
  const texto = MENSAGENS[state.categoria] ?? MENSAGENS.outros;
  return {
    messages: [new AIMessage(texto)],
  };
}
