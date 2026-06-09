import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  lgpdAceito: Annotation<boolean | null>({ value: (_, b) => b, default: () => null }),
});

export type GraphState = typeof GraphAnnotation.State;
