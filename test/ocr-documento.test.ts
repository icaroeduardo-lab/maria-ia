process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { nomesCompativeis, cpfsCompativeis, compararComCadastro } from "../src/core/ocr-documento.js";

// Card #20260203 — comparação tolerante de nome (normaliza acento/caixa,
// tolera abreviação/erro pequeno) e exata de CPF (só dígitos). Puro, sem
// tocar S3/Bedrock — mesmo racional de test/mask.test.ts.

test("nomesCompativeis: idêntico bate", () => {
  assert.equal(nomesCompativeis("Maria da Silva", "Maria da Silva"), true);
});

test("nomesCompativeis: tolera acento e caixa", () => {
  assert.equal(nomesCompativeis("joao pereira", "João Pereira"), true);
  assert.equal(nomesCompativeis("MARIA COSTA", "maria costa"), true);
});

test("nomesCompativeis: tolera abreviação (prefixo)", () => {
  assert.equal(nomesCompativeis("Joao S. Pereira", "João Silva Pereira"), true);
});

test("nomesCompativeis: tolera 1 token divergente em nome composto (3+ tokens)", () => {
  assert.equal(nomesCompativeis("Maria de Souza Costa", "Maria Aparecida Souza Costa"), true);
});

test("nomesCompativeis: nome completamente diferente não bate", () => {
  assert.equal(nomesCompativeis("Maria da Silva", "Joao Pereira"), false);
});

test("nomesCompativeis: vazio nunca bate", () => {
  assert.equal(nomesCompativeis("", "Maria Silva"), false);
  assert.equal(nomesCompativeis("Maria Silva", ""), false);
  assert.equal(nomesCompativeis(null, undefined), false);
});

test("cpfsCompativeis: exige exatamente os mesmos 11 dígitos", () => {
  assert.equal(cpfsCompativeis("111.444.777-35", "11144477735"), true);
  assert.equal(cpfsCompativeis("11144477735", "11144477736"), false);
});

test("cpfsCompativeis: formato inválido (não 11 dígitos) nunca bate", () => {
  assert.equal(cpfsCompativeis("123", "123"), false);
  assert.equal(cpfsCompativeis("", ""), false);
});

test("compararComCadastro: match true só quando nome E cpf batem", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "111.444.777-35" },
    "Joao Pereira",
    "11144477735"
  );
  assert.equal(r.match, true);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: true });
});

test("compararComCadastro: cpf divergente derruba match mesmo com nome ok", () => {
  const r = compararComCadastro({ nome: "João Pereira", cpf: "11144477735" }, "Joao Pereira", "22233344456");
  assert.equal(r.match, false);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: false });
});

test("compararComCadastro: OCR sem extrair nada nunca dá match", () => {
  const r = compararComCadastro({ nome: null, cpf: null }, "Joao Pereira", "11144477735");
  assert.equal(r.match, false);
  assert.deepEqual(r.detalhes, { nome_ok: false, cpf_ok: false });
});
