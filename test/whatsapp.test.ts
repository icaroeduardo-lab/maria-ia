import { test } from "node:test";
import assert from "node:assert/strict";
import { extrairMensagens } from "../src/core/channels/whatsapp.js";

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

// Issue #74: imagem/documento — só guarda id/mime/nome (download é adiado
// pro processarMensagemWhatsApp, que checa o contexto antes de baixar).
test("imagem → guarda mediaId/mediaMimeType/mediaNomeOriginal", () => {
  const m = extrairMensagens(corpo([
    { id: "wamid.4", from: "5521999", type: "image", image: { id: "media-img-1", mime_type: "image/jpeg", filename: "foto.jpg" } },
  ]));
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], {
    id: "wamid.4",
    from: "5521999",
    mediaId: "media-img-1",
    mediaMimeType: "image/jpeg",
    mediaNomeOriginal: "foto.jpg",
  });
  assert.equal(m[0].texto, undefined);
});

test("documento → guarda mediaId/mediaMimeType/mediaNomeOriginal", () => {
  const m = extrairMensagens(corpo([
    { id: "wamid.5", from: "5521999", type: "document", document: { id: "media-doc-1", mime_type: "application/pdf", filename: "comprovante.pdf" } },
  ]));
  assert.equal(m.length, 1);
  assert.deepEqual(m[0], {
    id: "wamid.5",
    from: "5521999",
    mediaId: "media-doc-1",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "comprovante.pdf",
  });
});

// regressão: tipo sem suporte (sticker, location, contacts...) continua
// sendo ignorado — não pode virar mediaId nem texto por engano
test("tipo não mapeado (location) → não gera mensagem (regressão)", () => {
  const m = extrairMensagens(corpo([
    { id: "wamid.6", from: "5521999", type: "location", location: { latitude: -22.9, longitude: -43.2 } },
  ]));
  assert.deepEqual(m, []);
});
