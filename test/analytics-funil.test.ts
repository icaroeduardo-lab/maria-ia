import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard estático do endpoint de funil (card #20260119): a contagem por nó
// tem que ser SEMPRE escopada por flowId — nunca misturar passagens de
// fluxos diferentes que reusem o mesmo nodeId.
// (Teste de fonte: o handler exige Postgres, não roda live aqui.)

test("funil por nó é escopado por flowId e trata fluxo inexistente", () => {
  const src = readFileSync(new URL("../src/api/routes/admin.ts", import.meta.url), "utf8");
  const inicio = src.indexOf('app.get("/analytics/funil/:flowId"');
  assert.ok(inicio > -1, "handler do funil não encontrado");
  const fim = src.indexOf("app.get(", inicio + 1);
  const handler = src.slice(inicio, fim);

  assert.match(handler, /where:\s*{\s*flowId\s*}/, "consulta de visitas deve filtrar por flowId");
  assert.match(handler, /404/, "fluxo inexistente deve responder 404");
});
