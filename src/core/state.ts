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
  // setado pelo nó transferir_humano — sinaliza pra rastrearConversa() que a
  // conversa deve entrar em handoff (não é "completed" nem segue automática)
  handoff:          Annotation<string>({ value: (_, b) => b, default: () => "" }),
  // tentativas inválidas por chave de pergunta (captura dinâmica) — reseta
  // implicitamente quando a chave é respondida com sucesso (some do objeto
  // junto com o fim do loop de retry; ver criarCaptura em engine/builder.ts)
  tentativas: Annotation<Record<string, number>>({
    value: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  // ids dos nodes do flow (builder visual) visitados, na ordem de execução —
  // append-only (sem dedupe: um node de loop, ex subgrafo, pode repetir).
  // Alimenta a trilha do canvas no chat de teste (issue #93); gravado no
  // wrapper central de builder.addNode em engine/builder.ts, não em cada node.
  trilhaExecutada: Annotation<string[]>({
    value: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type GraphState = typeof GraphAnnotation.State;
