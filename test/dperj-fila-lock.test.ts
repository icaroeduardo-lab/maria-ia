import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard estático (issue #68): processarFila() precisa claimar itens via
// FOR UPDATE SKIP LOCKED — sem isso, 2+ réplicas da API (api_min=2 em prod)
// podem pegar o mesmo item pendente e reenviar duplicado à DPERJ.
// (Teste de fonte: exercitar concorrência real exige Postgres, fora do
// padrão dos testes deste repo — validado manualmente, ver PR #68.)

test("processarFila claima itens com FOR UPDATE SKIP LOCKED antes de processar", () => {
  const src = readFileSync(new URL("../src/core/dperj.ts", import.meta.url), "utf8");
  const inicio = src.indexOf("export async function processarFila");
  assert.ok(inicio > -1, "processarFila não encontrada");
  const corpo = src.slice(inicio);

  assert.match(corpo, /FOR UPDATE SKIP LOCKED/, "claim deve usar SKIP LOCKED (evita bloquear entre réplicas)");
  assert.match(corpo, /RETURNING/, "claim deve ser atômico via UPDATE...RETURNING, não um SELECT solto");
  assert.match(corpo, /bloqueadoAte:\s*null/, "falha deve liberar o item pro próximo ciclo (limpar bloqueadoAte)");
});
