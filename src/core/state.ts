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
  // id do Assistido (Prisma) já identificado/cadastrado nesta conversa —
  // populado por identificar-assistido.ts assim que o cadastro é confirmado
  // ou criado; "" enquanto não identificado ou sem Postgres (issue #86).
  assistidoId: Annotation<string>({ value: (_, b) => b, default: () => "" }),
  // id do Assistido candidato encontrado por CPF, aguardando confirmação de
  // nome (sim/não) — campo de trabalho interno do sub-fluxo de identificação,
  // não confundir com assistidoId (só setado após confirmação/cadastro).
  assistidoCandidatoId: Annotation<string>({ value: (_, b) => b, default: () => "" }),
  // tipo do Caso "aberto" encontrado para o assistido identificado (ex:
  // "Pensão alimentícia") — "" quando não há caso em aberto. Usado só para
  // compor a pergunta de verificar-caso-aberto.ts e mapear a categoria da
  // triagem quando o assistido confirma que é sobre esse caso.
  casoAbertoTipo: Annotation<string>({ value: (_, b) => b, default: () => "" }),
});

export type GraphState = typeof GraphAnnotation.State;
