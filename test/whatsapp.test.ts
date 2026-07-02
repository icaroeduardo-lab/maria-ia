import { test } from "node:test";
import assert from "node:assert/strict";
import { extrairMensagens } from "../src/channels/whatsapp.js";

// Corpo no formato do webhook da Meta.
const corpo = (msgs: unknown[]) => ({
  entry: [{ changes: [{ value: { messages: msgs } }] }],
});

test("mensagem de texto → {id, from, texto}", () => {
  const m = extrairMensagens(corpo([
    { id: "wamid.1", from: "5521999", type: "text", text: { body: "oi" } },
  ]));
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], { id: "wamid.1", from: "5521999", texto: "oi" });
});

test("resposta de botão vem pelo id (true/false)", () => {
  const m = extrairMensagens(corpo([
    { id: "wamid.2", from: "5521999", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "true" } } },
  ]));
  assert.equal(m[0].texto, "true");
});

test("áudio → guarda audioId (para transcrever)", () => {
  const m = extrairMensagens(corpo([
    { id: "wamid.3", from: "5521999", type: "audio", audio: { id: "media-abc" } },
  ]));
  assert.equal(m[0].audioId, "media-abc");
  assert.equal(m[0].texto, undefined);
});

test("body sem mensagens → lista vazia", () => {
  assert.deepEqual(extrairMensagens({}), []);
  assert.deepEqual(extrairMensagens(corpo([])), []);
});
