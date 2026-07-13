import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverCampo, resolverCampoCondicao, interpolar } from "../src/core/engine/campos.js";

test("resolverCampo lê chave simples", () => {
  assert.equal(resolverCampo({ nome: "Maria" }, "nome"), "Maria");
});

test("resolverCampo navega JSON aninhado por dot notation", () => {
  const dados = { resultado: JSON.stringify({ dados: { nome: "Maria" } }) };
  assert.equal(resolverCampo(dados, "resultado.dados.nome"), "Maria");
});

test("resolverCampo retorna vazio para caminho inexistente", () => {
  assert.equal(resolverCampo({}, "a.b.c"), "");
});

test("resolverCampoCondicao normaliza sim/não para true/false", () => {
  assert.equal(resolverCampoCondicao({ x: "sim" }, "x"), "true");
  assert.equal(resolverCampoCondicao({ x: "não" }, "x"), "false");
});

test("interpolar substitui {{chave}} pelo valor bruto", () => {
  assert.equal(interpolar("Olá {{nome}}", { nome: "Maria" }), "Olá Maria");
});

test("interpolar com {{mask:chave}} aplica máscara de PII", () => {
  const dados = {
    resultado_cpf: JSON.stringify({
      dados: {
        nome: "João da Silva",
        cpf: "00000000000",
        telefone: "21999990000",
        email: "joao@example.com",
        dataNascimento: "1985-03-22",
      },
    }),
  };
  const txt = interpolar(
    "Nome: {{mask:resultado_cpf.dados.nome}} CPF: {{mask:resultado_cpf.dados.cpf}}",
    dados
  );
  assert.equal(txt, "Nome: J••• d••• S••• CPF: •••.•••.••0-••");
});

test("interpolar com mask: em campo sem máscara conhecida devolve valor cru", () => {
  assert.equal(interpolar("{{mask:situacao}}", { situacao: "regular" }), "regular");
});
