process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AIMessage } from "@langchain/core/messages";
import { extrairAtualizacao, enviarTelegram } from "../src/core/channels/telegram.js";

function mockarFetch(handler: (url: string, init?: RequestInit) => Response) {
  return mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init)
  );
}

afterEach(() => {
  mock.reset();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

// ── extrairAtualizacao (parsing de update) ──────────────────────────────────

test("mensagem de texto → {updateId, chatId, texto}", () => {
  const u = extrairAtualizacao({
    update_id: 10,
    message: { chat: { id: 555 }, text: "oi" },
  });
  assert.deepEqual(u, { updateId: 10, chatId: 555, texto: "oi" });
});

test("callback_query (botão inline) → texto = data + callbackQueryId presente", () => {
  const u = extrairAtualizacao({
    update_id: 11,
    callback_query: { id: "cbq-1", data: "true", message: { chat: { id: 555 } } },
  });
  assert.deepEqual(u, { updateId: 11, chatId: 555, texto: "true", callbackQueryId: "cbq-1" });
});

test("callback_query sem chat associado → null (não dá pra responder)", () => {
  const u = extrairAtualizacao({
    update_id: 12,
    callback_query: { id: "cbq-2", data: "true", message: {} },
  });
  assert.equal(u, null);
});

test("mensagem sem texto, foto nem documento (sticker/etc) → null (sem suporte)", () => {
  const u = extrairAtualizacao({
    update_id: 13,
    message: { chat: { id: 555 } }, // sem .text/.photo/.document
  });
  assert.equal(u, null);
});

test("update sem message nem callback_query → null", () => {
  assert.equal(extrairAtualizacao({ update_id: 14 }), null);
  assert.equal(extrairAtualizacao({}), null);
});

// ── enviarTelegram (sender) ─────────────────────────────────────────────────

test("sem TELEGRAM_BOT_TOKEN → modo dev, não chama a Bot API", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar a Bot API sem token");
  });
  await enviarTelegram(555, [new AIMessage("oi")]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("com TELEGRAM_BOT_TOKEN → chama a Bot API no método certo, sem vazar 'method' no corpo", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  let chamada: { url: string; body: unknown } | null = null;
  mockarFetch((url, init) => {
    chamada = { url, body: JSON.parse(String(init?.body ?? "{}")) };
    return new Response("{}", { status: 200 });
  });
  await enviarTelegram(555, [new AIMessage("oi")]);
  assert.ok(chamada);
  assert.match(chamada!.url, /\/botfake-token\/sendMessage$/);
  assert.equal((chamada!.body as { text: string }).text, "oi");
  assert.equal((chamada!.body as { method?: string }).method, undefined);
});

// ── Guard estático: callback respondido mesmo antes do dedupe/fila ─────────
// (senão o botão fica "carregando" pro usuário em caso de reentrega — ver
// comentário em telegram.ts / responderCallback)

test("webhook responde o callback_query ANTES do dedupe e do enfileiramento/processamento", () => {
  const src = readFileSync(new URL("../src/core/channels/telegram.ts", import.meta.url), "utf8");
  const iCallback = src.indexOf("responderCallback(atualizacao.callbackQueryId)");
  const iDedupe = src.indexOf("jaProcessado(String(atualizacao.updateId))");
  const iFila = src.indexOf("filaConfigurada()");
  assert.ok(iCallback > -1 && iDedupe > -1 && iFila > -1, "trechos esperados não encontrados");
  assert.ok(iCallback < iDedupe, "callback deve ser respondido antes do dedupe");
  assert.ok(iDedupe < iFila, "dedupe deve rodar antes de enfileirar/processar");
});
