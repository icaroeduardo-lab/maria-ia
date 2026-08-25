// Credenciais falsas ANTES de qualquer import (mesmo racional de
// captura-documento.test.ts / test-chat-upload-admin.test.ts): força
// fallbacks determinísticos, nunca toca AWS/Postgres de verdade — S3Client é
// sempre mockado via S3Client.prototype.send.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  extrairAtualizacao,
  processarDocumentoTelegram,
  processarMensagemTelegram,
} from "../src/core/channels/telegram.js";

// Bug real (canal Telegram, PR #215): fluxo travava numa pergunta tipo
// "documento" porque o webhook só extraía message.text — foto/PDF mandado
// pelo assistido nunca virava resposta, o grafo ficava parado pra sempre
// (interrupt sem resume). Este arquivo cobre a extração de foto/documento do
// update e o download/validação/gravação (mesmo contrato do WhatsApp, ver
// test/captura-documento.test.ts para a parte de engine — canal-agnóstica).

afterEach(() => {
  mock.reset();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

function mockarFetchTelegram(opts: { filePath?: string | null; fileBuffer?: Buffer }) {
  return mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/getFile")) {
      if (opts.filePath === null) return new Response(JSON.stringify({ ok: false }), { status: 200 });
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: opts.filePath ?? "documents/file.pdf" } }),
        { status: 200 }
      );
    }
    if (url.includes("/file/bot")) {
      return new Response(new Uint8Array(opts.fileBuffer ?? Buffer.alloc(0)), { status: 200 });
    }
    // sendMessage / answerCallbackQuery / etc (mensagens de erro amigáveis)
    return new Response("{}", { status: 200 });
  });
}

function mockarS3Sucesso() {
  return mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) return {};
    throw new Error(`Command não mockado: ${(cmd as { constructor: { name: string } })?.constructor?.name}`);
  });
}

const BYTES_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x41)]);
const BYTES_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 0x00)]);
const BYTES_INVALIDOS = Buffer.alloc(50, 0x00); // sem assinatura de magic bytes conhecida

// ── extrairAtualizacao: foto/documento (issue #74 estendida ao Telegram) ────

test("update com foto → mediaId = file_id do maior tamanho (último do array), mimeType jpeg fixo", () => {
  const u = extrairAtualizacao({
    update_id: 20,
    message: {
      chat: { id: 777 },
      photo: [
        { file_id: "small", file_size: 100 },
        { file_id: "big", file_size: 5000 },
      ],
    },
  });
  assert.deepEqual(u, {
    updateId: 20,
    chatId: 777,
    mediaId: "big",
    mediaMimeType: "image/jpeg",
    mediaNomeOriginal: "foto.jpg",
  });
});

test("update com documento → mediaId/mediaMimeType/mediaNomeOriginal do próprio documento", () => {
  const u = extrairAtualizacao({
    update_id: 21,
    message: {
      chat: { id: 777 },
      document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "comprovante.pdf" },
    },
  });
  assert.deepEqual(u, {
    updateId: 21,
    chatId: 777,
    mediaId: "doc-1",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "comprovante.pdf",
  });
});

test("documento sem file_name → mediaNomeOriginal default 'documento'", () => {
  const u = extrairAtualizacao({
    update_id: 22,
    message: { chat: { id: 777 }, document: { file_id: "doc-2", mime_type: "image/png" } },
  });
  assert.equal(u?.mediaNomeOriginal, "documento");
});

test("mensagem sem texto, foto, documento nem chat válido → null (sticker/etc, sem suporte)", () => {
  assert.equal(extrairAtualizacao({ update_id: 23, message: { chat: { id: 777 } } }), null);
});

// ── processarMensagemTelegram: gate de contexto (mesmo BDD do WhatsApp) ─────
// sessão nova (thread nunca invocado) → tipoPerguntaPendente resolve null →
// mídia fora do gate → NÃO baixa, responde fallback amigável.

test("mídia fora do gate (sem pergunta pendente tipo documento) → ignora e responde fallback, não baixa", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  const chamadas: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    chamadas.push(String(input));
    if (String(input).includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.match(body.text, /não estou esperando um documento/i);
    }
    return new Response("{}", { status: 200 });
  });

  await processarMensagemTelegram({
    from: `fora-gate-${Date.now()}`,
    mediaId: "file-123",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "doc.pdf",
  });

  assert.ok(!chamadas.some((u) => u.includes("/getFile")), "não deveria chamar getFile fora do gate");
  assert.ok(
    chamadas.some((u) => u.includes("/sendMessage")),
    "deveria responder o fallback"
  );
});

// ── processarDocumentoTelegram: download/validação/gravação ─────────────────

test("foto válida → baixa, valida magic bytes e grava metadado {nome, tamanho, mimeType}", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  mockarFetchTelegram({ filePath: "photos/foto.jpg", fileBuffer: BYTES_JPEG });
  const s3Mock = mockarS3Sucesso();

  const resultado = await processarDocumentoTelegram("tg:1", {
    from: "1",
    mediaId: "file-foto",
    mediaMimeType: "image/jpeg",
    mediaNomeOriginal: "foto.jpg",
  });

  assert.ok(resultado, "deveria retornar o JSON de metadado");
  const meta = JSON.parse(resultado!);
  assert.deepEqual(meta, { nome: "foto.jpg", tamanho: BYTES_JPEG.length, mimeType: "image/jpeg" });
  assert.equal(s3Mock.mock.callCount(), 1, "deveria gravar no S3 exatamente 1 vez");
});

test("documento PDF válido → baixa, valida magic bytes e grava metadado", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  mockarFetchTelegram({ filePath: "documents/comprovante.pdf", fileBuffer: BYTES_PDF });
  const s3Mock = mockarS3Sucesso();

  const resultado = await processarDocumentoTelegram("tg:2", {
    from: "2",
    mediaId: "file-doc",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "comprovante.pdf",
  });

  assert.ok(resultado);
  const meta = JSON.parse(resultado!);
  assert.deepEqual(meta, { nome: "comprovante.pdf", tamanho: BYTES_PDF.length, mimeType: "application/pdf" });
  assert.equal(s3Mock.mock.callCount(), 1);
});

test("mimetype declarado fora da lista aceita → erro de formato, nem tenta baixar", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  const fetchMock = mockarFetchTelegram({});
  const s3Mock = mockarS3Sucesso();

  const resultado = await processarDocumentoTelegram("tg:3", {
    from: "3",
    mediaId: "file-doc-invalido",
    mediaMimeType: "application/msword",
    mediaNomeOriginal: "curriculo.doc",
  });

  assert.equal(resultado, null);
  assert.equal(s3Mock.mock.callCount(), 0, "não deve gravar no S3");
  assert.ok(
    !fetchMock.mock.calls.some((c) => String(c.arguments[0]).includes("/getFile")),
    "não deveria chamar getFile pra um mimetype rejeitado de cara"
  );
});

test("arquivo > 10MB → rejeita após o download, não grava no S3", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  const grande = Buffer.alloc(10 * 1024 * 1024 + 1);
  mockarFetchTelegram({ filePath: "documents/grande.pdf", fileBuffer: grande });
  const s3Mock = mockarS3Sucesso();

  const resultado = await processarDocumentoTelegram("tg:4", {
    from: "4",
    mediaId: "file-grande",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "grande.pdf",
  });

  assert.equal(resultado, null);
  assert.equal(s3Mock.mock.callCount(), 0);
});

test("magic bytes não batem com o mimetype declarado → erro de formato", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  mockarFetchTelegram({ filePath: "documents/fake.pdf", fileBuffer: BYTES_INVALIDOS });
  const s3Mock = mockarS3Sucesso();

  const resultado = await processarDocumentoTelegram("tg:5", {
    from: "5",
    mediaId: "file-fake",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "fake.pdf",
  });

  assert.equal(resultado, null);
  assert.equal(s3Mock.mock.callCount(), 0);
});

test("sem TELEGRAM_BOT_TOKEN (modo dev) → não tenta baixar, erro amigável", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("não deveria chamar a Bot API sem token");
  });

  const resultado = await processarDocumentoTelegram("tg:6", {
    from: "6",
    mediaId: "file-x",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "doc.pdf",
  });

  assert.equal(resultado, null);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("getFile falha (ok:false, ex: arquivo > 20MB do lado do Telegram) → erro amigável, não lança", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  mockarFetchTelegram({ filePath: null });
  const s3Mock = mockarS3Sucesso();

  const resultado = await processarDocumentoTelegram("tg:7", {
    from: "7",
    mediaId: "file-sem-path",
    mediaMimeType: "application/pdf",
    mediaNomeOriginal: "doc.pdf",
  });

  assert.equal(resultado, null);
  assert.equal(s3Mock.mock.callCount(), 0);
});
