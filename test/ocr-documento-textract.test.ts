process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IdentityDocumentField } from "@aws-sdk/client-textract";
import { mapearCamposAnalyzeId } from "../src/core/ocr-documento-textract.js";

// Issue #194 — avaliação do Textract AnalyzeID como alternativa ao Bedrock
// (ver veredito completo no comentário de topo de ocr-documento-textract.ts:
// NÃO substitui o Bedrock, fica só implementado/testado). Testa só o
// mapeamento (puro, sem chamar AWS) — mesmo racional de
// test/ocr-documento.test.ts pras funções de comparação.

function campo(tipo: string, texto: string): IdentityDocumentField {
  return { Type: { Text: tipo }, ValueDetection: { Text: texto } };
}

test("mapearCamposAnalyzeId: monta nome a partir de FIRST/MIDDLE/LAST_NAME", () => {
  const r = mapearCamposAnalyzeId([
    campo("FIRST_NAME", "Maria"),
    campo("MIDDLE_NAME", "da"),
    campo("LAST_NAME", "Silva"),
    campo("DATE_OF_BIRTH", "15/03/1990"),
    campo("DOCUMENT_NUMBER", "11144477735"),
  ]);
  assert.deepEqual(r, { nome: "Maria da Silva", cpf: "11144477735", dataNascimento: "15/03/1990" });
});

test("mapearCamposAnalyzeId: sem MIDDLE_NAME, monta só FIRST + LAST", () => {
  const r = mapearCamposAnalyzeId([campo("FIRST_NAME", "Joao"), campo("LAST_NAME", "Pereira")]);
  assert.equal(r.nome, "Joao Pereira");
});

test("mapearCamposAnalyzeId: inclui SUFFIX quando presente", () => {
  const r = mapearCamposAnalyzeId([
    campo("FIRST_NAME", "Andre"),
    campo("LAST_NAME", "Eduardo"),
    campo("SUFFIX", "Junior"),
  ]);
  assert.equal(r.nome, "Andre Eduardo Junior");
});

test("mapearCamposAnalyzeId: campos vazios não entram no nome nem viram string vazia", () => {
  const r = mapearCamposAnalyzeId([
    campo("FIRST_NAME", "Joao"),
    campo("MIDDLE_NAME", ""),
    campo("LAST_NAME", "Pereira"),
    campo("DOCUMENT_NUMBER", ""),
    campo("DATE_OF_BIRTH", ""),
  ]);
  assert.deepEqual(r, { nome: "Joao Pereira", cpf: null, dataNascimento: null });
});

test("mapearCamposAnalyzeId: nenhum documento reconhecido (lista vazia) devolve tudo null", () => {
  assert.deepEqual(mapearCamposAnalyzeId([]), { nome: null, cpf: null, dataNascimento: null });
});

test("mapearCamposAnalyzeId: nenhum campo de nome presente devolve nome null (não string vazia)", () => {
  const r = mapearCamposAnalyzeId([campo("DATE_OF_BIRTH", "01/01/2000")]);
  assert.equal(r.nome, null);
});

// Regressão do teste ao vivo 2026-08-13 (issue #194): AnalyzeID confundiu a
// sigla do órgão emissor (DETRAN) impressa na CNH com o sobrenome — não é
// bug do mapeamento (ele monta o nome certinho a partir do que o Textract
// devolveu), é limitação do próprio Textract com documento brasileiro. Este
// teste só documenta que o mapeamento reproduz fielmente o que a AWS
// devolveu, mesmo quando a AWS devolveu campo errado.
test("mapearCamposAnalyzeId: reproduz fielmente a resposta real observada (inclusive quando errada)", () => {
  const r = mapearCamposAnalyzeId([
    campo("FIRST_NAME", "ANDRE"),
    campo("MIDDLE_NAME", "FERREIRA EDUARDO"),
    campo("LAST_NAME", "DETRAN"),
    campo("SUFFIX", "JUNIOR"),
    campo("DATE_OF_BIRTH", "11/08/1992"),
    campo("DOCUMENT_NUMBER", ""),
  ]);
  assert.deepEqual(r, {
    nome: "ANDRE FERREIRA EDUARDO DETRAN JUNIOR",
    cpf: null,
    dataNascimento: "11/08/1992",
  });
});
