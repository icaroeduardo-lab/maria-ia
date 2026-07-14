import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard estático (card #20260127): marcar/desmarcar-template são metadado
// — não podem criar FlowVersion (não é uma mudança de conteúdo do fluxo).
// (Teste de fonte: handlers exigem Postgres, não rodam live aqui.)

test("marcar-template e desmarcar-template não chamam criarVersao", () => {
  const src = readFileSync(new URL("../src/api/routes/admin.ts", import.meta.url), "utf8");

  for (const rota of ["marcar-template", "desmarcar-template"]) {
    const inicio = src.indexOf(`"/flows/:id/${rota}"`);
    assert.ok(inicio > -1, `rota ${rota} não encontrada`);
    const fim = src.indexOf("app.post(", inicio + 1);
    const handler = src.slice(inicio, fim > -1 ? fim : inicio + 500);

    assert.doesNotMatch(handler, /criarVersao/, `${rota} não deve versionar (é metadado, não conteúdo)`);
    assert.match(handler, /404/, `${rota} deve tratar fluxo inexistente`);
  }
});

test("GET /flows expõe isTemplate na listagem", () => {
  const src = readFileSync(new URL("../src/api/routes/admin.ts", import.meta.url), "utf8");
  const inicio = src.indexOf('app.get("/flows",');
  const fim = src.indexOf("app.get(", inicio + 1);
  const handler = src.slice(inicio, fim);
  assert.match(handler, /isTemplate:\s*true/, "select da lista deve incluir isTemplate");
});
