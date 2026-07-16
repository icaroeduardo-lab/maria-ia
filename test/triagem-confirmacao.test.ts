// Credenciais falsas ANTES de qualquer import: mesmo padrão de test/fluxo.test.ts
// (dotenv não sobrescreve env já setada) — nenhum teste aqui chama Bedrock de
// verdade. A classificação do modelo (fallback vs. legítimo) é testada via
// classificarCategoria(), que é pura e não depende de rede.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { StateGraph, MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { GraphAnnotation, type GraphState } from "../src/core/state.js";
import {
  classificarCategoria,
  triagemConfirmar,
  triagemConfirmarRoute,
  triagemEscolher,
  triagemCapturarEscolha,
} from "../src/core/nodes/atendimento/triagem.js";

// Issue #84 — Fase 1 (sem API real da DPERJ, sem opções dinâmicas: fora de
// escopo). Cobre o node de confirmação inserido entre `triagem` e
// `extrator_inicial` no grafo estático (src/core/graph.ts) e o parsing
// diferenciado de fallback em classificarCategoria().

// textos das mensagens AI de um resultado (mesmo helper de fluxo.test.ts)
function textos(state: { messages: Array<{ content: unknown }> }): string {
  return state.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ")
    )
    .join(" | ");
}

// opções (type: "options") oferecidas nas mensagens AI de um resultado
function opcoes(state: { messages: Array<{ content: unknown }> }): string[] {
  return state.messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : (m.content as Array<{ type: string; options?: string[] }>)
          .filter((b) => b.type === "options")
          .flatMap((b) => b.options ?? [])
  );
}

let seq = 0;
const config = () => ({ configurable: { thread_id: `teste-triagem-confirmacao-${Date.now()}-${seq++}` } });

async function responder(graph: ReturnType<typeof construirGrafo>, cfg: object, fala: string) {
  await graph.updateState(cfg, { messages: [new HumanMessage(fala)] });
  return await graph.invoke(null, cfg);
}

// Recorta só o pedaço do grafo estático relevante à issue: um stub no lugar
// de `triagem` (evita Bedrock real) já com `categoria` classificada, seguido
// pelos nodes REAIS de confirmação/escolha — mesma fiação e mesmo padrão de
// interruptAfter usado em src/core/graph.ts.
function construirGrafo(categoriaInicial: string) {
  return new StateGraph(GraphAnnotation)
    .addNode("triagem_stub", async (): Promise<Partial<GraphState>> => ({ categoria: categoriaInicial }))
    .addNode("triagem_confirmar", triagemConfirmar)
    .addNode("triagem_escolher", triagemEscolher)
    .addNode("triagem_capturar_escolha", triagemCapturarEscolha)
    .addNode("fluxo_normal", async (): Promise<Partial<GraphState>> => ({})) // marca "seguiu classificado"
    .addEdge("__start__", "triagem_stub")
    .addEdge("triagem_stub", "triagem_confirmar")
    .addConditionalEdges("triagem_confirmar", triagemConfirmarRoute, {
      confirmado: "fluxo_normal",
      corrigir: "triagem_escolher",
    })
    .addEdge("triagem_escolher", "triagem_capturar_escolha")
    .addEdge("triagem_capturar_escolha", "fluxo_normal")
    .addEdge("fluxo_normal", "__end__")
    .compile({
      checkpointer: new MemorySaver(),
      interruptAfter: ["triagem_confirmar", "triagem_escolher"],
    });
}

test("Cenário: IA classifica corretamente e assistido confirma", async () => {
  const graph = construirGrafo("familia_pensao");
  const cfg = config();

  // 1º turno: node de triagem classifica, node de confirmação pergunta e pausa
  const r1 = await graph.invoke({}, cfg);
  assert.match(textos(r1), /Família\/Pensão/);
  assert.equal(r1.categoria, "familia_pensao");

  // 2º turno: assistido responde "sim" (true) → segue com a categoria já classificada
  const r2 = await responder(graph, cfg, "true");
  assert.equal(r2.categoria, "familia_pensao");
  assert.doesNotMatch(textos(r2), /Qual dessas opções/);
});

test("Cenário: IA classifica errado e assistido corrige", async () => {
  const graph = construirGrafo("trabalhista"); // classificação errada de propósito
  const cfg = config();

  await graph.invoke({}, cfg);

  // assistido responde "não" (false) → mostra lista de categorias
  const r2 = await responder(graph, cfg, "false");
  assert.match(textos(r2), /Qual dessas opções/);
  assert.ok(opcoes(r2).includes("Família/Pensão"), "lista deve oferecer 'Família/Pensão' como opção");
  assert.equal(r2.categoria, "trabalhista", "categoria ainda não deve mudar só por recusar");

  // assistido escolhe "Família/Pensão" na lista → sobrescreve state.categoria
  const r3 = await responder(graph, cfg, "Família/Pensão");
  assert.equal(r3.categoria, "familia_pensao");
});

test("Cenário: resposta do modelo não bate com nenhuma categoria → fallback logado", () => {
  const original = console.warn;
  const chamadas: unknown[][] = [];
  console.warn = (...args: unknown[]) => { chamadas.push(args); };
  try {
    const resultado = classificarCategoria("desculpe, não consigo classificar esse relato");
    assert.equal(resultado.categoria, "outros");
    assert.equal(resultado.fallback, true);
    assert.equal(chamadas.length, 1, "deve emitir exatamente 1 log de fallback");
    assert.match(String(chamadas[0][0]), /\[triagem\] fallback: resposta não reconhecida/);
  } finally {
    console.warn = original;
  }
});

test("Cenário: modelo responde literalmente 'outros' → classificação legítima, sem log de fallback", () => {
  const original = console.warn;
  const chamadas: unknown[][] = [];
  console.warn = (...args: unknown[]) => { chamadas.push(args); };
  try {
    const resultado = classificarCategoria("outros");
    assert.equal(resultado.categoria, "outros");
    assert.equal(resultado.fallback, false);
    assert.equal(chamadas.length, 0, "resposta legítima 'outros' não deve logar fallback");
  } finally {
    console.warn = original;
  }
});

test("classificarCategoria: reconhece categoria mesmo com texto ao redor", () => {
  const r = classificarCategoria("A categoria é: familia_pensao.");
  assert.equal(r.categoria, "familia_pensao");
  assert.equal(r.fallback, false);
});
