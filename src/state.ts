import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  lgpdAceito:     Annotation<boolean>({ value: (_, b) => b, default: () => false }),
  categoria:      Annotation<string>({ value: (_, b) => b, default: () => "" }),
  dadosColetados: Annotation<Record<string, string>>({
    value: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
});

export type GraphState = typeof GraphAnnotation.State;
