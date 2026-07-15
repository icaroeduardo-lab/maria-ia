// Credenciais falsas ANTES de qualquer import — mesmo racional de fluxo.test.ts:
// força fallbacks determinísticos, nunca chama Bedrock/Postgres de verdade.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { buildGraphFromFlow, type FlowJSON } from "../src/core/engine/builder.js";

// Issue #74: captura dinâmica de tipoPergunta "documento" — mesmo padrão de
// test/validacao-retry-pergunta.test.ts (cpf/telefone/cep/data). O node
// pergunta não muda de forma nenhuma; o valor esperado é o JSON de metadado
// { nome, tamanho, mimeType } (nunca URL/bytes — regra LGPD, ver
// src/core/documentos.ts e VALIDADORES.documento em validacao-resposta.ts).

let seq = 0;
const config = () => ({ configurable: { thread_id: `teste-doc-${Date.now()}-${seq++}` } });

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

async function responder(graph: ReturnType<typeof buildGraphFromFlow>, cfg: object, fala: string) {
  await graph.updateState(cfg, { messages: [new HumanMessage(fala)] });
  return await graph.invoke(null, cfg);
}

function flowDocumento(): FlowJSON {
  return {
    id: "t-doc-1",
    nodes: [
      { id: "p_doc", type: "pergunta", data: { texto: "Envie seu comprovante (foto ou PDF, até 10MB).", chave: "comprovante", tipoPergunta: "documento", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [{ id: "e1", source: "p_doc", target: "fim" }],
  };
}

test("JSON válido de metadado grava exatamente esse JSON e avança o fluxo", async () => {
  const graph = buildGraphFromFlow(flowDocumento());
  const cfg = config();

  await graph.invoke({}, cfg);
  const metadado = JSON.stringify({ nome: "doc.pdf", tamanho: 1000, mimeType: "application/pdf" });
  const r = await responder(graph, cfg, metadado);

  assert.equal(r.dadosColetados.comprovante, metadado);
  assert.ok(r.protocolo, "deve seguir até o encerramento sem re-perguntar");
});

test("texto puro dispara retry (mensagem de erro), não grava dadosColetados", async () => {
  const graph = buildGraphFromFlow(flowDocumento());
  const cfg = config();

  await graph.invoke({}, cfg);
  const r = await responder(graph, cfg, "oi");

  assert.equal(r.dadosColetados.comprovante, undefined, "não deve gravar valor fora do formato");
  assert.match(textos(r), /não recebi um arquivo válido/i);
  assert.equal(r.tentativas.comprovante, 1);
});

test("JSON malformado dispara o mesmo comportamento de retry", async () => {
  const graph = buildGraphFromFlow(flowDocumento());
  const cfg = config();

  await graph.invoke({}, cfg);
  const r = await responder(graph, cfg, "{not json");

  assert.equal(r.dadosColetados.comprovante, undefined);
  assert.match(textos(r), /não recebi um arquivo válido/i);
  assert.equal(r.tentativas.comprovante, 1);
});
