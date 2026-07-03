import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheGet, cacheSet } from "../src/core/cache.js";

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
