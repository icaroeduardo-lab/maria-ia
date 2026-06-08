import "dotenv/config";
import { ChatBedrockConverse } from "@langchain/aws";
import { Annotation, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";

const AddressAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  rua: Annotation<string>({ value: (_, b) => b, default: () => "" }),
  numero: Annotation<string>({ value: (_, b) => b, default: () => "" }),
  bairro: Annotation<string>({ value: (_, b) => b, default: () => "" }),
});

const saveAddressTool = tool(
  async ({ rua, numero, bairro }) =>
    `Endereço registrado: ${rua}, nº ${numero} - ${bairro}`,
  {
    name: "salvar_endereco",
    description: "Salva o endereço residencial quando todos os campos foram coletados",
    schema: z.object({
      rua: z.string().describe("Nome da rua"),
      numero: z.string().describe("Número da residência"),
      bairro: z.string().describe("Nome do bairro"),
    }),
  }
);

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
}).bindTools([saveAddressTool]);

const SYSTEM_PROMPT = `Você é um assistente que coleta dados residenciais do usuário.
Colete obrigatoriamente os três campos abaixo — faça uma pergunta de cada vez de forma natural:
- Nome da rua
- Número da residência
- Nome do bairro

Quando tiver os três campos confirmados, chame a ferramenta salvar_endereco imediatamente.`;

async function callModel(state: typeof AddressAnnotation.State) {
  const response = await model.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    ...state.messages,
  ]);
  return { messages: [response] };
}

async function address(state: typeof AddressAnnotation.State) {
  const lastAI = state.messages.findLast(
    (m): m is AIMessage => m instanceof AIMessage
  );
  const toolCall = lastAI?.tool_calls?.find(
    (tc: { name: string }) => tc.name === "salvar_endereco"
  );

  if (!toolCall) return {};

  return {
    messages: [
      new ToolMessage({ tool_call_id: toolCall.id!, content: "Endereço salvo!" }),
    ],
    rua: toolCall.args.rua as string,
    numero: toolCall.args.numero as string,
    bairro: toolCall.args.bairro as string,
  };
}

function routeAfterModel(state: typeof AddressAnnotation.State) {
  const last = state.messages.at(-1);
  if (last instanceof AIMessage && last.tool_calls?.length) return "address";
  return "__end__";
}

function routeAfterAddress(state: typeof AddressAnnotation.State) {
  return state.rua && state.numero && state.bairro ? "__end__" : "model";
}

export const graph = new StateGraph(AddressAnnotation)
  .addNode("model", callModel)
  .addNode("address", address)
  .addEdge("__start__", "model")
  .addConditionalEdges("model", routeAfterModel)
  .addConditionalEdges("address", routeAfterAddress)
  .compile();
