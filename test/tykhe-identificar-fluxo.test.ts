// Credenciais falsas ANTES de qualquer import (mesmo padrão de fluxo.test.ts
// / tykhe-mensagem.test.ts): sem BEDROCK_KB_ID, o retriever de RAG fica null
// (contextoRag nunca é buscado — nada de rede AWS nesse caminho). O LLM de
// classificação em si é mockado abaixo (mock.method em model.withStructuredOutput)
// pra nunca bater no Bedrock de verdade, mas ainda decidir a categoria a
// partir do texto recebido — prova que o relato de fato chega até a IA.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { HumanMessage } from "@langchain/core/messages";
import { montarApp } from "../src/api/app.js";
import { model } from "../src/core/engine/ia.js";

// Cobre POST /api/tykhe/identificar-fluxo (src/api/routes/tykhe/identificar-fluxo.ts)
// — a fatia BEM menor que /api/tykhe/mensagem: só classifica um relato numa
// categoria, sem rodar o motor conversacional (sem saudação/LGPD/multi-turn).

afterEach(() => {
  mock.reset();
});

// Simula o Bedrock respondendo com a categoria certa pro relato recebido —
// sem chamar a AWS de verdade. Espelha o mesmo shape que classificarTexto()
// (core/engine/ia.ts) espera de volta de `model.withStructuredOutput(schema).invoke(...)`.
function mockarClassificacaoLLM(resolver: (falaRecebida: string) => string) {
  return mock.method(model, "withStructuredOutput", () => ({
    invoke: async (mensagens: HumanMessage[]) => {
      const fala = String(mensagens[mensagens.length - 1]?.content ?? "");
      return { categoria: resolver(fala) };
    },
  }));
}

test("relato claramente de pessoa presa devolve a categoria pessoa_presa", async () => {
  const llmMock = mockarClassificacaoLLM((fala) =>
    /preso|flagrante/i.test(fala) ? "pessoa_presa" : "outros"
  );
  const app = await montarApp();

  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/identificar-fluxo",
    payload: { relato: "meu marido foi preso ontem em flagrante, queria saber como visitar ele" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { categoria: "pessoa_presa" });
  assert.equal(llmMock.mock.callCount(), 1, "a classificação de fato chamou a IA (mock), não caiu direto no fallback");
});

test("relato de pensão alimentícia devolve categoria diferente (alimentação, não pessoa_presa)", async () => {
  mockarClassificacaoLLM((fala) => (/pens[ãa]o/i.test(fala) ? "alimentação" : "outros"));
  const app = await montarApp();

  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/identificar-fluxo",
    payload: { relato: "meu ex-marido não paga a pensão do meu filho há 3 meses, preciso de ajuda" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { categoria: "alimentação" });
});

test("400: relato ausente", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/identificar-fluxo",
    payload: {},
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  assert.match(res.json().erro, /relato/);
});

test("400: relato vazio (só espaços)", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/identificar-fluxo",
    payload: { relato: "   " },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  assert.match(res.json().erro, /relato/);
});

test("sem Bedrock disponível (LLM indisponível de verdade), degrada pro matcher por palavra-chave — nunca quebra a rota", async () => {
  // aqui NÃO mockamos o LLM: as credenciais falsas fazem a chamada real ao
  // Bedrock falhar, e classificarTexto() cai no fallback determinístico
  // (mesmo contrato testado em fluxo.test.ts) — prova que a rota nunca 500a
  // só porque a IA está fora do ar.
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/identificar-fluxo",
    payload: { relato: "o pai não paga a pensão do meu filho" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().categoria, "alimentação");
});
