import { ChatBedrockConverse } from "@langchain/aws";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const SYSTEM_PROMPT = `Você é a Maria, assistente virtual da Defensoria Pública do RJ.
Responda de forma natural, acolhedora e humana — como se fosse uma atendente real.
Diga que entendeu o caso do usuário, que vai ajudá-lo e que vai precisar fazer algumas perguntas para dar continuidade ao atendimento.
Seja BREVE: máximo 2 frases. Não explique demais. Não use bullet points. Não mencione categorias ou departamentos.`;

export async function informativo(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  const caso = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(caso),
  ]);

  return {
    messages: [new AIMessage(response.content as string)],
  };
}
