import { ChatBedrockConverse } from "@langchain/aws";
import { AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphState } from "../../state.js";
import { env } from "../../env.js";

const model = new ChatBedrockConverse({
  model: env.bedrockModelId(),
  region: env.awsRegion(),
});

const retriever = new AmazonKnowledgeBaseRetriever({
  topK: 3,
  knowledgeBaseId: env.bedrockKbId()!,
  region: env.awsRegion(),
});

const CATEGORIAS = ["trabalhista", "inss_federal", "familia_pensao", "penal", "outros"] as const;
type Categoria = (typeof CATEGORIAS)[number];

// Rótulo amigável de cada categoria, usado na pergunta de confirmação e na
// lista de opções mostrada quando o assistido corrige a classificação.
const LABEL_POR_CATEGORIA: Record<Categoria, string> = {
  trabalhista: "Trabalhista",
  inss_federal: "INSS/Federal",
  familia_pensao: "Família/Pensão",
  penal: "Penal",
  outros: "Outros",
};

// Mapa inverso (rótulo amigável → valor interno) para capturar a escolha manual.
const CATEGORIA_POR_LABEL = new Map<string, Categoria>(
  CATEGORIAS.map((c) => [LABEL_POR_CATEGORIA[c], c])
);

// Interpreta a resposta crua do modelo. `fallback: true` significa que NENHUMA
// categoria foi reconhecida no texto (caiu em "outros" por falha de parsing,
// não porque o modelo respondeu "outros" de fato) — quem chama decide se loga.
export function classificarCategoria(raw: string): { categoria: Categoria; fallback: boolean } {
  const texto = raw.trim().toLowerCase();
  const categoria = CATEGORIAS.find((c) => texto.includes(c));
  if (categoria) return { categoria, fallback: false };
  // "outros" aqui é fallback por falha de parsing, não classificação legítima
  // do modelo — logar diferenciado (ver issue #84).
  console.warn(`[triagem] fallback: resposta não reconhecida: "${raw.trim().slice(0, 80)}"`);
  return { categoria: "outros", fallback: true };
}

export async function triagem(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m.getType() === "human");
  const caso = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  const docs = await retriever.invoke(caso);
  const contexto = docs.map((d) => d.pageContent).join("\n\n");

  const system = `Você é um classificador de demandas jurídicas da Defensoria Pública do RJ.

Use o contexto abaixo para entender quais serviços a Defensoria oferece e classificar corretamente.

<contexto>
${contexto}
</contexto>

Analise a mensagem do usuário e responda APENAS com uma das categorias, sem explicações:
trabalhista | inss_federal | familia_pensao | penal | outros`;

  const response = await model.invoke([
    new SystemMessage(system),
    new HumanMessage(caso),
  ]);

  const raw = typeof response.content === "string" ? response.content : "";
  const { categoria } = classificarCategoria(raw);

  return { categoria };
}

export function triagemRoute(state: GraphState) {
  return state.categoria || "outros";
}

// Confirmação da classificação: pergunta sim/não antes de seguir com a
// categoria detectada — dá ao assistido a chance de corrigir uma triagem errada.
export async function triagemConfirmar(state: GraphState) {
  const label = LABEL_POR_CATEGORIA[state.categoria as Categoria] ?? state.categoria;
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "text", text: `Entendi que é sobre *${label}*, posso continuar?` },
          { type: "boolean", trueLabel: true, falseLabel: false },
        ],
      }),
    ],
  };
}

// "sim" → segue com a categoria já classificada; "não" → mostra a lista pra escolha manual.
export function triagemConfirmarRoute(state: GraphState): "confirmado" | "corrigir" {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  return lastHuman?.content === "true" ? "confirmado" : "corrigir";
}

// Mostra as categorias como lista de opções pra escolha manual (correção da triagem).
export async function triagemEscolher(_state: GraphState) {
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "text", text: "Sem problemas! Qual dessas opções descreve melhor o seu caso?" },
          { type: "options", options: CATEGORIAS.map((c) => LABEL_POR_CATEGORIA[c]) },
        ],
      }),
    ],
  };
}

// Captura a escolha manual e sobrescreve state.categoria antes de seguir o roteamento normal.
export function triagemCapturarEscolha(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
  const escolha = typeof lastHuman?.content === "string" ? lastHuman.content.trim() : "";
  const categoria = CATEGORIA_POR_LABEL.get(escolha) ?? state.categoria;
  return { categoria };
}
