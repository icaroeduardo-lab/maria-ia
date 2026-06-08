import { HumanMessage } from "@langchain/core/messages";
import { graph } from "./graph.js";

const result = await graph.invoke({
  messages: [new HumanMessage("Olá! Quem é você?")],
});

console.log(result.messages.at(-1)?.content);
