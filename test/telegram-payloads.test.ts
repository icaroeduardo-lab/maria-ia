import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toTelegramPayloads,
  formatar,
  truncar,
  truncarCallbackData,
} from "../src/core/channels/telegram-payloads.js";

const CHAT_ID = 999888777;

test("string vira um payload sendMessage", () => {
  const p = toTelegramPayloads(CHAT_ID, "olá") as any[];
  assert.equal(p.length, 1);
  assert.equal(p[0].method, "sendMessage");
  assert.equal(p[0].text, "olá");
  assert.equal(p[0].chat_id, CHAT_ID);
  assert.equal(p[0].parse_mode, "Markdown");
});

test("markdown ** vira * (negrito Telegram, modo clássico)", () => {
  assert.equal(formatar("**oi**"), "*oi*");
  const p = toTelegramPayloads(CHAT_ID, "**negrito**") as any[];
  assert.equal(p[0].text, "*negrito*");
});

test("imagem antes de texto preserva a ordem dos payloads", () => {
  const p = toTelegramPayloads(CHAT_ID, [
    { type: "image_url", image_url: { url: "http://x/y.jpg" } },
    { type: "text", text: "abaixo" },
  ] as any) as any[];
  assert.equal(p.length, 2);
  assert.equal(p[0].method, "sendPhoto");
  assert.equal(p[0].photo, "http://x/y.jpg");
  assert.equal(p[1].method, "sendMessage");
  assert.equal(p[1].text, "abaixo");
});

test("texto antes da imagem também preserva a ordem", () => {
  const p = toTelegramPayloads(CHAT_ID, [
    { type: "text", text: "veja abaixo 👇" },
    { type: "image_url", image_url: { url: "http://x/ficha.jpg" } },
  ] as any) as any[];
  assert.equal(p[0].method, "sendMessage");
  assert.equal(p[1].method, "sendPhoto");
});

test("boolean vira inline_keyboard com callback_data true/false", () => {
  const p = toTelegramPayloads(CHAT_ID, [
    { type: "text", text: "Você aceita?" },
    { type: "boolean" },
  ] as any) as any[];
  assert.equal(p.length, 1);
  assert.equal(p[0].method, "sendMessage");
  assert.equal(p[0].text, "Você aceita?");
  const row = p[0].reply_markup.inline_keyboard[0];
  assert.deepEqual(
    row.map((b: any) => b.callback_data),
    ["true", "false"]
  );
});

test("options vira 1 botão por linha; callback_data = texto completo da opção", () => {
  const p = toTelegramPayloads(CHAT_ID, [
    { type: "text", text: "Escolha:" },
    { type: "options", options: ["curta", "outra opção"] },
  ] as any) as any[];
  const kb = p[0].reply_markup.inline_keyboard;
  assert.equal(kb.length, 2); // 1 linha por opção
  assert.equal(kb[0][0].callback_data, "curta");
  assert.equal(kb[1][0].callback_data, "outra opção");
});

test("options limita a 10 linhas", () => {
  const opts = Array.from({ length: 15 }, (_, i) => `op${i}`);
  const p = toTelegramPayloads(CHAT_ID, [{ type: "options", options: opts }] as any) as any[];
  assert.equal(p[0].reply_markup.inline_keyboard.length, 10);
});

test("cta_url vira inline_keyboard com botão tipo url (não callback_data)", () => {
  const p = toTelegramPayloads(CHAT_ID, [
    { type: "text", text: "Confirme sua identidade" },
    { type: "cta_url", url: "https://x/kyc.html?t=abc", text: "Fazer selfie" },
  ] as any) as any[];
  assert.equal(p.length, 1);
  const btn = p[0].reply_markup.inline_keyboard[0][0];
  assert.equal(btn.url, "https://x/kyc.html?t=abc");
  assert.equal(btn.callback_data, undefined);
  assert.equal(btn.text, "Fazer selfie");
});

test("truncar não corta abaixo do limite", () => {
  assert.equal(truncar("abc", 24), "abc");
});

test("truncarCallbackData preserva texto que cabe em 64 bytes", () => {
  assert.equal(truncarCallbackData("Pensão por morte"), "Pensão por morte");
});

test("truncarCallbackData corta acima de 64 bytes sem quebrar caractere multibyte", () => {
  const longa = "ç".repeat(70); // cada 'ç' = 2 bytes UTF-8 → estoura 64 bytes
  const cortada = truncarCallbackData(longa);
  assert.ok(Buffer.byteLength(cortada, "utf8") <= 64);
  // decodifica sem lançar / sem caractere de substituição (U+FFFD)
  assert.ok(!cortada.includes("�"));
});
