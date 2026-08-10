// DATABASE_URL="" (mesmo padrão do CI real, ver CLAUDE.md): sem Postgres
// disponível aqui. Os cenários que dependem de S3/Bedrock reais (200 com
// match, 404 sem documento no bucket) não são exercitáveis via .inject()
// neste ambiente — mesma limitação já aceita pelo repo pra outras rotas que
// tocam AWS ao vivo (ver test/upload-documento.test.ts). Este arquivo testa
// AO VIVO os cenários que retornam ANTES de tocar S3/Bedrock (400 sem
// sessionId, 422 sem nome/cpf coletados) e usa guard estático pro resto.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { montarApp } from "../src/api/app.js";

test("sem sessionId nem _sessao no corpo → 400, nada tocado", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { nome: "Maria Silva", cpf: "11144477735" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("sessionId presente mas nome/cpf ausentes (corpo e sem Postgres) → 422, não chega no S3", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { sessionId: `teste-422-${Date.now()}` },
  });
  assert.equal(res.statusCode, 422);
  await app.close();
});

test("aceita _sessao (nome do campo que o nó api do engine manda) no lugar de sessionId", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { _sessao: `teste-alias-${Date.now()}` }, // sem nome/cpf → cai no 422, não no 400
  });
  assert.equal(res.statusCode, 422, "deve reconhecer _sessao como sessionId (não deveria dar 400)");
  await app.close();
});

// ── Guard estático: cenários que precisam de S3/Bedrock reais ──────────────
const src = readFileSync(new URL("../src/api/routes/documentos.ts", import.meta.url), "utf8");

test("checagem de nome/cpf vem ANTES da busca no S3 (evita chamada cara/desnecessária)", () => {
  const idxCheck = src.indexOf("if (!nomeCadastro || !cpfCadastro)");
  const idxBusca = src.indexOf("buscarDocumentoMaisRecente(");
  assert.ok(idxCheck > -1 && idxBusca > -1 && idxCheck < idxBusca);
});

test("busca no S3 vem ANTES do OCR (Bedrock) — evita chamar o modelo sem ter arquivo", () => {
  const idxBusca = src.indexOf("buscarDocumentoMaisRecente(");
  const idxOcr = src.indexOf("extrairDadosDocumento(");
  assert.ok(idxBusca > -1 && idxOcr > -1 && idxBusca < idxOcr);
});

test("LGPD: resposta de sucesso nunca inclui nome/cpf cru, só o resultado da comparação", () => {
  const idxReturn = src.indexOf("return resultado;");
  assert.ok(idxReturn > -1);
  // a variável retornada vem só de compararComCadastro (match/detalhes) —
  // nunca reexpõe `extraido` (nome/cpf do OCR) nem nomeCadastro/cpfCadastro
  assert.match(src, /const resultado = compararComCadastro\(/);
  assert.doesNotMatch(src, /return\s*\{[^}]*\bextraido\b/s, "não deve devolver o objeto extraído bruto");
});

test("LGPD: nenhum console.log/error imprime nome/cpf em texto claro", () => {
  const logs = src.match(/console\.(log|error)\([^)]*\)/gs) ?? [];
  assert.ok(logs.length > 0, "esperava pelo menos 1 log");
  for (const l of logs) {
    assert.doesNotMatch(l, /\$\{nomeCadastro\}|\$\{cpfCadastro\}|\$\{extraido/, `log vaza PII: ${l}`);
  }
});

test("erros (404/422/500) não vazam detalhe interno — mensagem fixa, sem interpolar dado sensível", () => {
  assert.match(src, /erro: "nenhum documento encontrado para esta sessão"/);
  assert.match(src, /erro: "nome\/cpf ainda não coletados nesta sessão"/);
  assert.match(src, /erro: "falha ao processar o documento"/);
});
