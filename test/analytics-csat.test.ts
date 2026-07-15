import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard estático do CSAT em GET /admin/analytics/summary (card #20260128):
// mediaCsat/csatPorCategoria/csatPorFluxo têm que ignorar conversas sem nota
// (csat: null) — null nunca pode contar como 0 na média.
// (Teste de fonte: o handler exige Postgres, não roda live aqui — mesmo
// padrão de test/analytics-funil.test.ts e test/flows-template.test.ts.)

function handlerSummary(): string {
  const src = readFileSync(new URL("../src/api/routes/admin.ts", import.meta.url), "utf8");
  const inicio = src.indexOf('app.get("/analytics/summary"');
  assert.ok(inicio > -1, "handler de /analytics/summary não encontrado");
  const fim = src.indexOf("app.get(", inicio + 1);
  return src.slice(inicio, fim);
}

test("mediaCsat usa aggregate _avg excluindo conversas sem nota", () => {
  const handler = handlerSummary();
  assert.match(
    handler,
    /aggregate\(\{\s*_avg:\s*\{\s*csat:\s*true\s*\},\s*where:\s*\{\s*csat:\s*\{\s*not:\s*null\s*\}\s*\}/,
    "mediaCsat deve vir de aggregate({ _avg: { csat: true }, where: { csat: { not: null } } })"
  );
  assert.match(handler, /mediaCsat:\s*mediaCsatAgg\._avg\.csat\s*\?\?\s*null/, "sem nenhuma nota, mediaCsat deve ser null");
});

test("csatPorCategoria e csatPorFluxo usam groupBy com _avg e excluem csat null", () => {
  const handler = handlerSummary();

  // pula o 1º groupBy por categoria (contagem, sem relação com csat) — o
  // bloco do csat vem depois, junto do aggregate de mediaCsat.
  const aggIdx = handler.indexOf("aggregate({");
  assert.ok(aggIdx > -1, "aggregate de mediaCsat não encontrado");

  const porCategoriaIdx = handler.indexOf('by: ["categoria"]', aggIdx);
  assert.ok(porCategoriaIdx > -1, "groupBy por categoria (csat) não encontrado após o aggregate de mediaCsat");
  const blocoCategoria = handler.slice(porCategoriaIdx, porCategoriaIdx + 200);
  assert.match(blocoCategoria, /_avg:\s*\{\s*csat:\s*true\s*\}/, "groupBy por categoria deve calcular _avg.csat");
  assert.match(blocoCategoria, /where:\s*\{\s*csat:\s*\{\s*not:\s*null\s*\}\s*\}/, "groupBy por categoria deve excluir csat null");

  const porFluxoIdx = handler.indexOf('by: ["flowId"]');
  assert.ok(porFluxoIdx > -1, "groupBy por flowId não encontrado");
  const blocoFluxo = handler.slice(porFluxoIdx, porFluxoIdx + 200);
  assert.match(blocoFluxo, /_avg:\s*\{\s*csat:\s*true\s*\}/, "groupBy por flowId deve calcular _avg.csat");
  assert.match(blocoFluxo, /where:\s*\{\s*csat:\s*\{\s*not:\s*null\s*\}\s*\}/, "groupBy por flowId deve excluir csat null");

  assert.match(handler, /csatPorCategoria:\s*csatPorCategoria\.map/, "resposta deve expor csatPorCategoria");
  assert.match(handler, /csatPorFluxo:\s*csatPorFluxo\.map/, "resposta deve expor csatPorFluxo");
});
