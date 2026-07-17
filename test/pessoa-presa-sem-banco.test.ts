// DATABASE_URL="" (mesmo padrão do CI real, ver CLAUDE.md): não há Postgres
// disponível neste ambiente de teste — cada rota deve degradar pra 503
// gracioso (mesmo padrão de test/upload-documento.test.ts).
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { montarApp } from "../src/api/app.js";

const ROTAS = [
  "/api/pessoa-presa/consultar-rg?rg=11111111111",
  "/api/pessoa-presa/consultar-processo?numero=123",
  "/api/pessoa-presa/casos?idPessoaPresa=PES-0001",
  "/api/pessoa-presa/orgao-responsavel?idSeap=SEAP-0001",
  "/api/pessoa-presa/orgao-responsavel-liberto?idSeap=SEAP-0001",
];

for (const url of ROTAS) {
  test(`GET ${url} sem DATABASE_URL configurado → 503 (degrada gracioso, como /api/assistidos/*)`, async () => {
    const app = await montarApp();
    const res = await app.inject({ method: "GET", url });
    await app.close();
    assert.equal(res.statusCode, 503);
  });
}
