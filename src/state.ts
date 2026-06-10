import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  lgpdAceito: Annotation<boolean>({ value: (_, b) => b, default: () => false }),
  etapa: Annotation<string>({ value: (_, b) => b, default: () => "inicio" }),
  categoria: Annotation<string>({ value: (_, b) => b, default: () => "" }),
});

export type GraphState = typeof GraphAnnotation.State;
