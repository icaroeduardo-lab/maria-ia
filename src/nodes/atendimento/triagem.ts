import { ChatBedrockConverse } from "@langchain/aws";
import { AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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

const CATEGORIAS = ["trabalhista", "inss_federal", "familia_pensao", "penal", "outros"] as const;

export async function triagem(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m.getType() === "human");
  const caso = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  const docs = await retriever.invoke(caso);
  const contexto = docs.map((d) => d.pageContent).join("\n\n");

  const system = `Você é um classificador de demandas jurídicas da Defensoria Pública do RJ.

Use o contexto abaixo para entender quais serviços a Defensoria oferece e classificar corretamente.

<contexto>
${contexto}
</contexto>

Analise a mensagem do usuário e responda APENAS com uma das categorias, sem explicações:
trabalhista | inss_federal | familia_pensao | penal | outros`;

  const response = await model.invoke([
    new SystemMessage(system),
    new HumanMessage(caso),
  ]);

  const raw = (typeof response.content === "string" ? response.content : "").trim().toLowerCase();
  const categoria = CATEGORIAS.find((c) => raw.includes(c)) ?? "outros";

  return { categoria };
}

export function triagemRoute(state: GraphState) {
  return state.categoria || "outros";
}
