import { test } from "node:test";
import assert from "node:assert/strict";
import { toWhatsAppPayloads, formatar, truncar } from "../src/channels/payloads.js";

const TO = "5521999999999";

test("string vira um payload de texto", () => {
  const p = toWhatsAppPayloads(TO, "olá") as any[];
  assert.equal(p.length, 1);
  assert.equal(p[0].type, "text");
  assert.equal(p[0].text.body, "olá");
  assert.equal(p[0].to, TO);
});

test("markdown ** vira * (negrito WhatsApp)", () => {
  assert.equal(formatar("**oi**"), "*oi*");
  const p = toWhatsAppPayloads(TO, "**negrito**") as any[];
  assert.equal(p[0].text.body, "*negrito*");
});

test("imagem antes de texto preserva a ordem dos payloads", () => {
  const p = toWhatsAppPayloads(TO, [
    { type: "image_url", image_url: { url: "http://x/y.jpg" } },
    { type: "text", text: "abaixo" },
  ] as any) as any[];
  assert.equal(p.length, 2);
  assert.equal(p[0].type, "image");
  assert.equal(p[0].image.link, "http://x/y.jpg");
  assert.equal(p[1].type, "text");
  assert.equal(p[1].text.body, "abaixo");
});

test("texto antes da imagem também preserva a ordem", () => {
  const p = toWhatsAppPayloads(TO, [
    { type: "text", text: "veja abaixo 👇" },
    { type: "image_url", image_url: { url: "http://x/ficha.jpg" } },
  ] as any) as any[];
  assert.equal(p[0].type, "text");
  assert.equal(p[1].type, "image");
});

test("boolean vira interactive button com o texto acumulado no body", () => {
  const p = toWhatsAppPayloads(TO, [
    { type: "text", text: "Você aceita?" },
    { type: "boolean" },
  ] as any) as any[];
  assert.equal(p.length, 1);
  assert.equal(p[0].type, "interactive");
  assert.equal(p[0].interactive.type, "button");
  assert.equal(p[0].interactive.body.text, "Você aceita?");
  const ids = p[0].interactive.action.buttons.map((b: any) => b.reply.id);
  assert.deepEqual(ids, ["true", "false"]);
});

test("options vira interactive list; id completo, title truncado em 24", () => {
  const longa = "Uma opção bem comprida que passa de 24 caracteres";
  const p = toWhatsAppPayloads(TO, [
    { type: "text", text: "Escolha:" },
    { type: "options", options: ["curta", longa] },
  ] as any) as any[];
  assert.equal(p[0].interactive.type, "list");
  const rows = p[0].interactive.action.sections[0].rows;
  assert.equal(rows[1].id, longa); // id mantém o texto completo
  assert.equal(rows[1].title.length, 24); // title truncado
  assert.ok(rows[1].title.endsWith("…"));
});

test("options limita a 10 linhas", () => {
  const opts = Array.from({ length: 15 }, (_, i) => `op${i}`);
  const p = toWhatsAppPayloads(TO, [{ type: "options", options: opts }] as any) as any[];
  assert.equal(p[0].interactive.action.sections[0].rows.length, 10);
});

test("truncar não corta abaixo do limite", () => {
  assert.equal(truncar("abc", 24), "abc");
});

test("cta_url vira interactive cta_url (botão que abre link)", () => {
  const p = toWhatsAppPayloads(TO, [
    { type: "text", text: "Confirme sua identidade" },
    { type: "cta_url", url: "https://x/kyc.html?t=abc", text: "Fazer selfie" },
  ] as any) as any[];
  assert.equal(p.length, 1);
  assert.equal(p[0].interactive.type, "cta_url");
  assert.equal(p[0].interactive.body.text, "Confirme sua identidade");
  assert.equal(p[0].interactive.action.name, "cta_url");
  assert.equal(p[0].interactive.action.parameters.url, "https://x/kyc.html?t=abc");
  assert.equal(p[0].interactive.action.parameters.display_text, "Fazer selfie");
});

test("cta_url trunca o rótulo do botão em 20 chars", () => {
  const p = toWhatsAppPayloads(TO, [
    { type: "cta_url", url: "https://x", text: "Um rótulo muito comprido demais" },
  ] as any) as any[];
  assert.equal(p[0].interactive.action.parameters.display_text.length, 20);
});
