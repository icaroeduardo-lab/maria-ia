import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  lgpdAceito:     Annotation<boolean>({ value: (_, b) => b, default: () => false }),
  categoria:      Annotation<string>({ value: (_, b) => b, default: () => "" }),
  dadosColetados: Annotation<Record<string, string>>({
    value: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  perguntasFeitas: Annotation<string[]>({
    value: (a, b) => [...new Set([...a, ...b])],
    default: () => [],
  }),
  ultimaPergunta:   Annotation<string>({ value: (_, b) => b, default: () => "" }),
  servicoConcluido: Annotation<boolean>({ value: (_, b) => b, default: () => false }),
  canal:            Annotation<string>({ value: (_, b) => b, default: () => "web" }),
  iniciadoEm:       Annotation<string>({ value: (_, b) => b, default: () => "" }),
  protocolo:        Annotation<string>({ value: (_, b) => b, default: () => "" }),
});

export type GraphState = typeof GraphAnnotation.State;
