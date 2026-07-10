// Credenciais falsas ANTES de qualquer import: dotenv não sobrescreve env já
// setada, então isso força os fallbacks determinísticos (keyword matcher etc.)
// mesmo numa máquina com .env válido — o teste nunca chama Bedrock de verdade.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { buildGraphFromFlow, type FlowJSON } from "../src/core/engine/builder.js";

// Teste de integração do engine: compila um flow JSON (como o builder visual
// produz) e roda multi-turn de verdade — invoke({}) + updateState/invoke(null)
// (o padrão crítico do CLAUDE.md). Pega regressão de FIAÇÃO do grafo
// (gate/captura/condição/encerramento) que teste unitário não pega.

let seq = 0;
const config = () => ({ configurable: { thread_id: `teste-fluxo-${Date.now()}-${seq++}` } });

// textos das mensagens AI de um resultado
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

test("fluxo pergunta → captura → encerrar (multi-turn com interrupt)", async () => {
  const flow: FlowJSON = {
    id: "t1",
    nodes: [
      { id: "boas", type: "mensagem", data: { texto: "Olá!" } },
      { id: "p_nome", type: "pergunta", data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "boas", target: "p_nome" },
      { id: "e2", source: "p_nome", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  // 1º turno: saudação + pergunta, para no interrupt
  const r1 = await graph.invoke({}, cfg);
  assert.match(textos(r1), /Olá!/);
  assert.match(textos(r1), /Qual seu nome\?/);
  assert.equal(r1.dadosColetados.nome, undefined);

  // 2º turno: resume com a resposta → captura + encerramento com protocolo
  const r2 = await responder(graph, cfg, "Maria da Silva");
  assert.equal(r2.dadosColetados.nome, "Maria da Silva");
  assert.ok(r2.protocolo, "encerramento deve gerar protocolo (modo mock)");
});

test("skip-gate: pergunta com chave já preenchida é pulada", async () => {
  const flow: FlowJSON = {
    id: "t2",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "João" } },
      { id: "p_nome", type: "pergunta", data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true } },
      { id: "p_idade", type: "pergunta", data: { texto: "Qual sua idade?", chave: "idade", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "seta", target: "p_nome" },
      { id: "e2", source: "p_nome", target: "p_idade" },
      { id: "e3", source: "p_idade", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  // nome já atribuído → gate pula direto pra idade
  const r1 = await graph.invoke({}, cfg);
  assert.doesNotMatch(textos(r1), /Qual seu nome\?/);
  assert.match(textos(r1), /Qual sua idade\?/);
  assert.equal(r1.dadosColetados.nome, "João");
});

test("condicao roteia pelo valor capturado (sim/não)", async () => {
  const flow: FlowJSON = {
    id: "t3",
    nodes: [
      { id: "p_tem", type: "pergunta", data: { texto: "Tem filhos?", chave: "tem_filhos", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "cond", type: "condicao", data: { campo: "tem_filhos" } },
      { id: "m_sim", type: "mensagem", data: { texto: "Ramo COM filhos" } },
      { id: "m_nao", type: "mensagem", data: { texto: "Ramo SEM filhos" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_tem", target: "cond" },
      // convenção do engine: sim_nao normaliza pra "true"/"false" (ids dos botões)
      { id: "e2", source: "cond", target: "m_sim", label: "true" },
      { id: "e3", source: "cond", target: "m_nao", label: "false" },
      { id: "e4", source: "m_sim", target: "fim" },
      { id: "e5", source: "m_nao", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);

  const cfgSim = config();
  await graph.invoke({}, cfgSim);
  const rSim = await responder(graph, cfgSim, "sim");
  assert.match(textos(rSim), /Ramo COM filhos/);
  assert.doesNotMatch(textos(rSim), /Ramo SEM filhos/);

  const cfgNao = config();
  await graph.invoke({}, cfgNao);
  const rNao = await responder(graph, cfgNao, "não tenho");
  assert.match(textos(rNao), /Ramo SEM filhos/);
});

test("classificar cai no matcher por palavra-chave sem Bedrock e roteia o tema", async () => {
  const flow: FlowJSON = {
    id: "t4",
    nodes: [
      { id: "p_relato", type: "pergunta", data: { texto: "Me conta o que houve", chave: "relato", semReescrita: true } },
      { id: "cls", type: "classificar", data: { chave: "categoria", opcoes: ["alimentação", "trabalhista", "outros"] } },
      { id: "m_ali", type: "mensagem", data: { texto: "Tema: pensão alimentícia" } },
      { id: "m_out", type: "mensagem", data: { texto: "Tema: outros" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_relato", target: "cls" },
      { id: "e2", source: "cls", target: "m_ali", label: "alimentação" },
      { id: "e3", source: "cls", target: "m_out", label: "*" },
      { id: "e4", source: "m_ali", target: "fim" },
      { id: "e5", source: "m_out", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  await graph.invoke({}, cfg);
  // credenciais falsas → LLM falha → fallback por palavra-chave ("pensão" → alimentação)
  const r = await responder(graph, cfg, "o pai não paga a pensão do meu filho");
  assert.equal(r.dadosColetados.categoria, "alimentação");
  assert.match(textos(r), /Tema: pensão alimentícia/);
});

test("pergunta sim_nao com saídas rotuladas roteia direto (sem nó condição)", async () => {
  const flow: FlowJSON = {
    id: "t5",
    nodes: [
      { id: "p_aceita", type: "pergunta", data: { texto: "Aceita os termos?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "m_sim", type: "mensagem", data: { texto: "Ramo ACEITOU" } },
      { id: "m_nao", type: "mensagem", data: { texto: "Ramo RECUSOU" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      // labels direto na pergunta — o caso do card #20260113
      { id: "e1", source: "p_aceita", target: "m_sim", label: "true" },
      { id: "e2", source: "p_aceita", target: "m_nao", label: "false" },
      { id: "e3", source: "m_sim", target: "fim" },
      { id: "e4", source: "m_nao", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);

  const cfgSim = config();
  await graph.invoke({}, cfgSim);
  const rSim = await responder(graph, cfgSim, "sim");
  assert.match(textos(rSim), /Ramo ACEITOU/);
  assert.doesNotMatch(textos(rSim), /Ramo RECUSOU/, "fan-out: só um ramo pode executar");

  const cfgNao = config();
  await graph.invoke({}, cfgNao);
  const rNao = await responder(graph, cfgNao, "não");
  assert.match(textos(rNao), /Ramo RECUSOU/);
  assert.doesNotMatch(textos(rNao), /Ramo ACEITOU/);
});

test("skip-gate em pergunta rotulada roteia pela resposta já preenchida", async () => {
  const flow: FlowJSON = {
    id: "t6",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "aceita", valor: "não" } },
      { id: "p_aceita", type: "pergunta", data: { texto: "Aceita?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "m_sim", type: "mensagem", data: { texto: "Ramo ACEITOU" } },
      { id: "m_nao", type: "mensagem", data: { texto: "Ramo RECUSOU" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e0", source: "seta", target: "p_aceita" },
      { id: "e1", source: "p_aceita", target: "m_sim", label: "true" },
      { id: "e2", source: "p_aceita", target: "m_nao", label: "false" },
      { id: "e3", source: "m_sim", target: "fim" },
      { id: "e4", source: "m_nao", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();
  // "aceita" já preenchido com "não" → pula a pergunta E cai no ramo certo
  const r = await graph.invoke({}, cfg);
  assert.doesNotMatch(textos(r), /Aceita\?/);
  assert.match(textos(r), /Ramo RECUSOU/);
  assert.doesNotMatch(textos(r), /Ramo ACEITOU/);
});

test("encerrar com texto customizado interpola {{protocolo}} e {{chave}}", async () => {
  const flow: FlowJSON = {
    id: "t-encerrar-texto",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "Maria" } },
      { id: "fim", type: "encerrar", data: { texto: "Obrigada {{nome}}! Protocolo: {{protocolo}}." } },
    ],
    edges: [{ id: "e1", source: "seta", target: "fim" }],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.ok(r.protocolo, "envio mock deve gerar protocolo antes da despedida");
  assert.match(textos(r), new RegExp(`Obrigada Maria! Protocolo: ${r.protocolo}\\.`));
  // não vaza placeholder cru
  assert.doesNotMatch(textos(r), /\{\{/);
});

test("encerrar sem texto mantém a mensagem padrão (regressão)", async () => {
  const flow: FlowJSON = {
    id: "t-encerrar-padrao",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "Maria" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [{ id: "e1", source: "seta", target: "fim" }],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.ok(r.protocolo);
  assert.match(textos(r), /protocolo \*/i); // texto padrão do encerramento cita o protocolo
});
