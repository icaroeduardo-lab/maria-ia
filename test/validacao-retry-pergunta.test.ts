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

// Card #20260120: validação de formato + retry na captura dinâmica
// (cpf/telefone/cep/data). Testa via multi-turn real (invoke/updateState),
// mesmo padrão de fluxo.test.ts — pega regressão de fiação do grafo.

let seq = 0;
const config = () => ({ configurable: { thread_id: `teste-retry-${Date.now()}-${seq++}` } });

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

function flowCpf(): FlowJSON {
  return {
    id: "t-retry-1",
    nodes: [
      { id: "p_cpf", type: "pergunta", data: { texto: "Qual seu CPF?", chave: "cpf", tipoPergunta: "cpf", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [{ id: "e1", source: "p_cpf", target: "fim" }],
  };
}

test("resposta em formato inválido não avança, re-pergunta com erro, não grava dadosColetados", async () => {
  const graph = buildGraphFromFlow(flowCpf());
  const cfg = config();

  await graph.invoke({}, cfg);
  const r = await responder(graph, cfg, "oi");

  assert.equal(r.dadosColetados.cpf, undefined, "não deve gravar valor fora do formato");
  assert.match(textos(r), /não parece um CPF válido/i);
  assert.equal(r.tentativas.cpf, 1);
});

test("resposta válida grava normalmente e segue (regressão)", async () => {
  const graph = buildGraphFromFlow(flowCpf());
  const cfg = config();

  await graph.invoke({}, cfg);
  const r = await responder(graph, cfg, "12345678901");

  assert.equal(r.dadosColetados.cpf, "12345678901");
  assert.ok(r.protocolo, "deve seguir até o encerramento sem re-perguntar");
});

test("depois de 3 tentativas inválidas, grava o valor bruto e segue (nunca trava)", async () => {
  const graph = buildGraphFromFlow(flowCpf());
  const cfg = config();

  await graph.invoke({}, cfg);
  await responder(graph, cfg, "oi"); // tentativa 1
  await responder(graph, cfg, "não sei"); // tentativa 2
  await responder(graph, cfg, "sla"); // tentativa 3
  const r = await responder(graph, cfg, "ainda errado"); // tentativa 4 → fallback

  assert.equal(r.dadosColetados.cpf, "ainda errado");
  assert.ok(r.protocolo, "deve seguir até o encerramento após o limite");
});

test("skip-gate continua pulando pergunta com validador quando a chave já está preenchida", async () => {
  const flow: FlowJSON = {
    id: "t-retry-2",
    nodes: [
      { id: "atrib", type: "atribuir", data: { chave: "cpf", valor: "00000000000" } },
      { id: "p_cpf", type: "pergunta", data: { texto: "Qual seu CPF?", chave: "cpf", tipoPergunta: "cpf", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "atrib", target: "p_cpf" },
      { id: "e2", source: "p_cpf", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  const r = await graph.invoke({}, cfg);
  assert.equal(r.dadosColetados.cpf, "00000000000");
  assert.ok(r.protocolo, "pergunta pulada — vai direto ao encerramento sem pausar");
});

test("pergunta sim_nao com saídas rotuladas não é afetada pelo retry (roteiaPorLabel intacto)", async () => {
  const flow: FlowJSON = {
    id: "t-retry-3",
    nodes: [
      { id: "p_sim", type: "pergunta", data: { texto: "Aceita?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "sim", type: "mensagem", data: { texto: "Show" } },
      { id: "nao", type: "mensagem", data: { texto: "Ok" } },
    ],
    edges: [
      { id: "e1", source: "p_sim", target: "sim", label: "true" },
      { id: "e2", source: "p_sim", target: "nao", label: "false" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  await graph.invoke({}, cfg);
  const r = await responder(graph, cfg, "sim");
  assert.match(textos(r), /Show/);
});
