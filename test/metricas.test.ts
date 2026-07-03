import { test } from "node:test";
import assert from "node:assert/strict";
import { medirReescrita, snapshotReescrita } from "../src/core/metricas.js";

test("contadores acumulam por evento", () => {
  const antes = snapshotReescrita();
  medirReescrita("hit");
  medirReescrita("hit");
  medirReescrita("miss");
  medirReescrita("falha");
  const depois = snapshotReescrita();
  assert.equal(depois.hit - antes.hit, 2);
  assert.equal(depois.miss - antes.miss, 1);
  assert.equal(depois.falha - antes.falha, 1);
});

test("snapshot é cópia (mutação externa não vaza)", () => {
  const s = snapshotReescrita();
  s.hit = 999_999;
  assert.notEqual(snapshotReescrita().hit, 999_999);
});
