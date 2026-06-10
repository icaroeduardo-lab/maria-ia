import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const CATEGORIAS = ["trabalhista", "inss_federal", "familia_pensao", "penal", "outros"] as const;

const SYSTEM_CLASSIFICAR = `Você é um classificador de demandas jurídicas da Defensoria Pública do RJ.
Analise a mensagem do usuário e responda APENAS com uma das categorias abaixo, sem explicações:

- trabalhista: questões de justiça do trabalho, CLT, demissão, FGTS, horas extras
- inss_federal: benefícios INSS, Caixa Econômica, Justiça Federal, DPU
- familia_pensao: pensão alimentícia, guarda, divórcio, família
- penal: crimes, processo criminal, delegacia
- outros: qualquer assunto que não se encaixe nas categorias acima`;

export async function triagem(state: GraphState) {
  const lastHuman = state.messages.findLast(
    (m) => m.getType() === "human"
  );

  const response = await model.invoke([
    new SystemMessage(SYSTEM_CLASSIFICAR),
    new HumanMessage(typeof lastHuman?.content === "string" ? lastHuman.content : ""),
  ]);

  const raw = (typeof response.content === "string" ? response.content : "").trim().toLowerCase();
  const categoria = CATEGORIAS.find((c) => raw.includes(c)) ?? "outros";

  return { categoria };
}

export function triagemRoute(state: GraphState) {
  return state.categoria || "outros";
}
