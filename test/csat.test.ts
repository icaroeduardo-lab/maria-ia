import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { csatValido } from "../src/core/chat.js";

// CSAT (card #20260128): nota 1-5 promovida de dadosColetados.csat pra
// Conversation.csat em rastrearConversa(), a cada turno.
// Cenário: "Nota válida é promovida pra coluna dedicada" — "4" (string, como
// vem da resposta de uma pergunta do fluxo) e 4 (number) devem validar igual.
test("csatValido aceita inteiro 1..5, string ou number", () => {
  assert.equal(csatValido("4"), 4);
  assert.equal(csatValido(4), 4);
  assert.equal(csatValido("1"), 1);
  assert.equal(csatValido("5"), 5);
  assert.equal(csatValido(1), 1);
  assert.equal(csatValido(5), 5);
});

// Cenário: "Resposta fora do range não quebra nem grava lixo" — "banana"/"9"/"0"
// (e variações: decimal, vazio, ausente) devem ser rejeitadas sem lançar.
test("csatValido rejeita não-numérico, fora do range 1..5 e decimais", () => {
  assert.equal(csatValido("banana"), null);
  assert.equal(csatValido("9"), null);
  assert.equal(csatValido("0"), null);
  assert.equal(csatValido(0), null);
  assert.equal(csatValido(9), null);
  assert.equal(csatValido("3.5"), null);
  assert.equal(csatValido(3.5), null);
  assert.equal(csatValido(""), null);
  assert.equal(csatValido(undefined), null);
  assert.equal(csatValido(null), null);
  assert.doesNotThrow(() => csatValido("banana"));
});

// Guard estático: garante que rastrearConversa() de fato usa csatValido() pra
// decidir a promoção (não só define a função) e que a rejeição vira aviso de
// log SEM o payload inteiro de dadosColetados (regra de LGPD do repo — csat
// não é PII, mas o resto de dadosColetados pode ser).
test("rastrearConversa promove csat validado e loga só o valor rejeitado, nunca o payload inteiro", () => {
  const src = readFileSync(new URL("../src/core/chat.ts", import.meta.url), "utf8");
  const inicio = src.indexOf("async function rastrearConversa");
  assert.ok(inicio > -1, "rastrearConversa não encontrada");
  const corpo = src.slice(inicio);

  assert.match(corpo, /csatValido\(coletados\.csat\)/, "deve validar dadosColetados.csat via csatValido");
  assert.match(corpo, /csat !== null && \{ csat \}/, "só inclui csat no update/create quando válido");
  assert.doesNotMatch(
    corpo.slice(0, corpo.indexOf("const dados = {")),
    /console\.(warn|error)\([^)]*coletados\)/,
    "aviso de csat inválido não pode logar o objeto dadosColetados inteiro"
  );
});
