import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheGet, cacheSet, cacheIncr } from "../src/core/cache.js";

// Sem Redis alcançável (CI), o cache cai para memória (L1) — round-trip deve valer.
test("cacheSet/cacheGet round-trip (memória)", async () => {
  await cacheSet("teste:x", ["a", "b", "c"], 60);
  const v = await cacheGet<string[]>("teste:x");
  assert.deepEqual(v, ["a", "b", "c"]);
});

test("cacheGet de chave inexistente → null", async () => {
  const v = await cacheGet("teste:nao-existe");
  assert.equal(v, null);
});

test("TTL expirado → null", async () => {
  await cacheSet("teste:ttl", { a: 1 }, -1); // já expirado
  const v = await cacheGet("teste:ttl");
  assert.equal(v, null);
});

// cacheIncr — rate limit do webhook WhatsApp (card #20260122)
test("cacheIncr incrementa a cada chamada dentro da janela", async () => {
  const chave = "teste:incr:1";
  assert.equal(await cacheIncr(chave, 60), 1);
  assert.equal(await cacheIncr(chave, 60), 2);
  assert.equal(await cacheIncr(chave, 60), 3);
});

test("cacheIncr com janela expirada reseta a contagem", async () => {
  const chave = "teste:incr:2";
  await cacheIncr(chave, -1); // janela já expirada na próxima chamada
  const v = await cacheIncr(chave, 60);
  assert.equal(v, 1, "janela expirada deve reiniciar a contagem em 1, não acumular");
});
