import { test } from "node:test";
import assert from "node:assert/strict";
import { validarFlow } from "../src/core/engine/validar.js";
import type { FlowNode, FlowEdge } from "../src/core/engine/builder.js";

const N = (id: string, type: FlowNode["type"], data: FlowNode["data"] = {}): FlowNode => ({ id, type, data });
const E = (source: string, target: string, label?: string): FlowEdge => ({ id: `${source}_${target}`, source, target, label });

test("fluxo válido simples → ok, sem erros", () => {
  const nodes = [N("a", "mensagem", { texto: "oi" }), N("b", "pergunta", { chave: "x", texto: "?" })];
  const edges = [E("a", "b")];
  const r = validarFlow(nodes, edges);
  assert.equal(r.ok, true);
  assert.deepEqual(r.erros, []);
});

test("fluxo vazio → erro", () => {
  const r = validarFlow([], []);
  assert.equal(r.ok, false);
  assert.match(r.erros[0], /sem nós/);
});

test("aresta para nó inexistente → erro", () => {
  const r = validarFlow([N("a", "mensagem", { texto: "oi" })], [E("a", "fantasma")]);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("fantasma")));
});

test("condicao sem campo → erro", () => {
  const r = validarFlow([N("c", "condicao", {})], []);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("condicao") && e.includes("campo")));
});

test("pergunta sem chave → erro; sem texto → aviso", () => {
  const r = validarFlow([N("p", "pergunta", {})], []);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("chave")));
  assert.ok(r.avisos.some((e) => e.includes("sem texto")));
});

test("api sem url → erro", () => {
  const r = validarFlow([N("api1", "api", { chave: "r" })], []);
  assert.ok(r.erros.some((e) => e.includes("api") && e.includes("url")));
});

test("subfluxo sem refFlowId → erro", () => {
  const r = validarFlow([N("sf", "subfluxo", {})], []);
  assert.ok(r.erros.some((e) => e.includes("subfluxo") && e.includes("refFlowId")));
});

test("id duplicado → erro", () => {
  const r = validarFlow([N("a", "mensagem", { texto: "1" }), N("a", "mensagem", { texto: "2" })], []);
  assert.ok(r.erros.some((e) => e.includes("duplicado")));
});

test("nó inalcançável → aviso (não erro)", () => {
  // a → b é o caminho; "solto" não recebe nem leva a nada e não é a entrada
  const nodes = [N("a", "mensagem", { texto: "1" }), N("b", "mensagem", { texto: "2" }), N("solto", "mensagem", { texto: "x" })];
  const edges = [E("a", "b")];
  const r = validarFlow(nodes, edges);
  assert.equal(r.ok, true); // inalcançável é aviso, não erro
  assert.ok(r.avisos.some((e) => e.includes("inalcançável") && e.includes("solto")));
});

test("mensagem sem texto e sem imagem → aviso", () => {
  const r = validarFlow([N("m", "mensagem", {})], []);
  assert.ok(r.avisos.some((e) => e.includes("mensagem") && e.includes("sem texto")));
});
