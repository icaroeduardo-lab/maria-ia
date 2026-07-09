import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard estático de LGPD: a listagem de conversas usa select enxuto — os
// campos que carregam PII sem máscara (metadados/dadosColetados/resumo) não
// podem entrar na resposta da lista. Detalhe mascara; revelar audita.
// (Teste de fonte, não de runtime: o handler exige Postgres; o contrato de
// LGPD aqui é "o select da lista não inclui os campos sensíveis".)

const CAMPOS_PROIBIDOS_NA_LISTA = ["metadados", "dadosColetados", "resumo"];

test("select da lista de conversas não inclui campos com PII", () => {
  const src = readFileSync(new URL("../src/api/routes/admin.ts", import.meta.url), "utf8");
  // isola o handler da lista (do app.get("/conversations" até o próximo app.)
  const inicio = src.indexOf('app.get("/conversations"');
  assert.ok(inicio > -1, "handler da lista não encontrado");
  const fim = src.indexOf("app.get(", inicio + 1);
  const handler = src.slice(inicio, fim);

  assert.match(handler, /select:\s*{/, "lista deve usar select explícito (não rows inteiras)");
  for (const campo of CAMPOS_PROIBIDOS_NA_LISTA) {
    assert.ok(
      !new RegExp(`${campo}\\s*:\\s*true`).test(handler),
      `campo sensível "${campo}" não pode entrar no select da lista`
    );
  }
});
