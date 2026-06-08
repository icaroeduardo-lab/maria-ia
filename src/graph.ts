import "dotenv/config";
import { ChatBedrockConverse } from "@langchain/aws";
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
});

async function callModel(state: typeof MessagesAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("model", callModel)
  .addEdge("__start__", "model")
  .addEdge("model", "__end__")
  .compile();
