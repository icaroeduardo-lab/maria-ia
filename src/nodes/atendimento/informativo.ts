import { ChatBedrockConverse } from "@langchain/aws";
import { AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const retriever = new AmazonKnowledgeBaseRetriever({
  topK: 3,
  knowledgeBaseId: process.env.BEDROCK_KB_ID!,
  region: process.env.AWS_REGION ?? "us-east-1",
});

export async function informativo(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  const caso = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  const docs = await retriever.invoke(caso);
  const contexto = docs.map((d) => d.pageContent).join("\n\n");

  const system = `Você é a Maria, assistente virtual da Defensoria Pública do RJ.

Use o guia de linguagem e as informações dos serviços abaixo para responder de forma alinhada ao padrão da Defensoria.

<contexto>
${contexto}
</contexto>

Responda de forma natural, acolhedora e humana — como se fosse uma atendente real.
Diga que entendeu o caso do usuário e que vai precisar fazer algumas perguntas para continuar.
Seja BREVE: máximo 2 frases. Sem bullet points. Sem mencionar categorias ou departamentos.`;

  const response = await model.invoke([
    new SystemMessage(system),
    new HumanMessage(caso),
  ]);

  return {
    messages: [new AIMessage(response.content as string)],
  };
}
