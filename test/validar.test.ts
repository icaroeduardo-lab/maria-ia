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

test("pergunta com múltiplas saídas sem roteamento → erro (fan-out)", () => {
  const r = validarFlow(
    [
      { id: "p", type: "pergunta", data: { chave: "x", texto: "?", tipoPergunta: "sim_nao" } },
      { id: "a", type: "mensagem", data: { texto: "a" } },
      { id: "b", type: "mensagem", data: { texto: "b" } },
    ] as never,
    [
      { id: "e1", source: "p", target: "a" },
      { id: "e2", source: "p", target: "b" },
    ] as never
  );
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("sem labels true/false")));
});

test("pergunta sim_nao com labels sim/não → erro orientando true/false", () => {
  const r = validarFlow(
    [
      { id: "p", type: "pergunta", data: { chave: "x", texto: "?", tipoPergunta: "sim_nao" } },
      { id: "a", type: "mensagem", data: { texto: "a" } },
      { id: "b", type: "mensagem", data: { texto: "b" } },
    ] as never,
    [
      { id: "e1", source: "p", target: "a", label: "sim" },
      { id: "e2", source: "p", target: "b", label: "não" },
    ] as never
  );
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes('use "true"/"false"')));
});

test("pergunta texto com 2 saídas → erro orientando nó condição", () => {
  const r = validarFlow(
    [
      { id: "p", type: "pergunta", data: { chave: "x", texto: "?", tipoPergunta: "texto" } },
      { id: "a", type: "mensagem", data: { texto: "a" } },
      { id: "b", type: "mensagem", data: { texto: "b" } },
    ] as never,
    [
      { id: "e1", source: "p", target: "a", label: "true" },
      { id: "e2", source: "p", target: "b", label: "false" },
    ] as never
  );
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes("nó condição")));
});

test("pergunta sim_nao com labels true/false corretos → ok", () => {
  const r = validarFlow(
    [
      { id: "p", type: "pergunta", data: { chave: "x", texto: "?", tipoPergunta: "sim_nao" } },
      { id: "a", type: "mensagem", data: { texto: "a" } },
      { id: "b", type: "mensagem", data: { texto: "b" } },
    ] as never,
    [
      { id: "e1", source: "p", target: "a", label: "true" },
      { id: "e2", source: "p", target: "b", label: "false" },
    ] as never
  );
  assert.equal(r.ok, true, r.erros.join("; "));
});

test("api externa sem camposCorpo → aviso de corpo vazio", () => {
  const r = validarFlow(
    [{ id: "a", type: "api", data: { url: "https://ex.com/x", chave: "r" } }] as never,
    [] as never
  );
  assert.equal(r.ok, true, r.erros.join("; "));
  assert.ok(r.avisos.some((a) => a.includes("camposCorpo")));
});

test("api interna sem camposCorpo → sem aviso (payload interno permitido)", () => {
  const r = validarFlow(
    [{ id: "a", type: "api", data: { url: "/api/consulta-cpf", chave: "r" } }] as never,
    [] as never
  );
  assert.ok(!r.avisos.some((a) => a.includes("camposCorpo")));
});

test("api com header de credencial em texto puro → aviso {{secret:NOME}}", () => {
  const r = validarFlow(
    [
      {
        id: "a",
        type: "api",
        data: { url: "https://ex.com/x", chave: "r", camposCorpo: [], headers: { "x-api-key": "abc123def456" } },
      },
    ] as never,
    [] as never
  );
  assert.ok(r.avisos.some((a) => a.includes("{{secret:")));
});

test("api com 2 saídas sem label erro → erro de fan-out", () => {
  const r = validarFlow(
    [
      { id: "a", type: "api", data: { url: "/x", chave: "r" } },
      { id: "m1", type: "mensagem", data: { texto: "1" } },
      { id: "m2", type: "mensagem", data: { texto: "2" } },
    ] as never,
    [
      { id: "e1", source: "a", target: "m1" },
      { id: "e2", source: "a", target: "m2" },
    ] as never
  );
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => e.includes('"erro"')));
});

test("api com saídas erro + default → ok", () => {
  const r = validarFlow(
    [
      { id: "a", type: "api", data: { url: "/x", chave: "r" } },
      { id: "m1", type: "mensagem", data: { texto: "1" } },
      { id: "m2", type: "mensagem", data: { texto: "2" } },
    ] as never,
    [
      { id: "e1", source: "a", target: "m1" },
      { id: "e2", source: "a", target: "m2", label: "erro" },
    ] as never
  );
  assert.equal(r.ok, true, r.erros.join("; "));
});
