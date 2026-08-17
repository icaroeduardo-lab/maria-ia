// Credenciais falsas ANTES de qualquer import — mesmo racional dos outros
// arquivos de canal (telegram-documento.test.ts, whatsapp.test.ts): força
// fallbacks determinísticos, nunca toca AWS/Postgres de verdade.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";
import { extrairAtualizacao, transcreverAudioTelegram } from "../src/core/channels/telegram.js";

// Achado adicional durante a investigação do bug de documento travado (PR
// #215): o Telegram também não tinha suporte a voz/áudio. Este arquivo cobre
// a extensão do mesmo pipeline de transcrição do WhatsApp
// (src/core/transcribe.ts, agora genérico) pro Telegram — SEM gate de
// contexto (áudio é aceito em qualquer ponto da conversa, diferente de
// foto/documento).

afterEach(() => {
  mock.reset();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

// ── extrairAtualizacao: voice/audio ──────────────────────────────────────────

test("update com voice (nota de voz) → audioId = file_id, sem texto/mediaId", () => {
  const u = extrairAtualizacao({
    update_id: 30,
    message: { chat: { id: 888 }, voice: { file_id: "voice-1" } },
  });
  assert.deepEqual(u, { updateId: 30, chatId: 888, audioId: "voice-1" });
});

test("update com audio (arquivo de música/podcast) → audioId = file_id (tratado igual a voice)", () => {
  const u = extrairAtualizacao({
    update_id: 31,
    message: { chat: { id: 888 }, audio: { file_id: "audio-1" } },
  });
  assert.deepEqual(u, { updateId: 31, chatId: 888, audioId: "audio-1" });
});

// ── transcreverAudioTelegram: baixa (getFile) + transcreve (Transcribe) ─────

function mockarFetchAudio(opts: { filePath?: string; transcriptUri?: string; transcript?: string }) {
  return mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/getFile")) {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: opts.filePath ?? "voice/audio.oga" } }),
        { status: 200 }
      );
    }
    if (url.includes("/file/bot")) {
      return new Response(new Uint8Array(Buffer.from("fake-ogg-bytes")), { status: 200 });
    }
    if (opts.transcriptUri && url === opts.transcriptUri) {
      return new Response(
        JSON.stringify({ results: { transcripts: [{ transcript: opts.transcript ?? "" }] } }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  });
}

function mockarTranscribeCompleto(transcriptUri: string) {
  return mock.method(TranscribeClient.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof StartTranscriptionJobCommand) return {};
    if (cmd instanceof GetTranscriptionJobCommand) {
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: "COMPLETED",
          Transcript: { TranscriptFileUri: transcriptUri },
        },
      };
    }
    throw new Error(`Command não mockado: ${(cmd as { constructor: { name: string } })?.constructor?.name}`);
  });
}

function mockarS3Sucesso() {
  return mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) return {};
    throw new Error(`Command não mockado: ${(cmd as { constructor: { name: string } })?.constructor?.name}`);
  });
}

// Sem mock de timers aqui (deliberado): o pipeline real espera 2s entre polls
// do Transcribe (ver transcreverAudio em core/transcribe.ts) — deixar rodar
// de verdade evita acoplar o teste ao mecanismo interno de setTimeout/polling,
// à custa de ~2s por teste que exercita o caminho completo.

test("voice válida → baixa, sobe pro S3, transcreve e devolve o texto (job COMPLETED)", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  const transcriptUri = "https://s3.example.com/transcript.json";
  mockarFetchAudio({ transcriptUri, transcript: "olá, preciso de ajuda com um processo" });
  mockarTranscribeCompleto(transcriptUri);
  const s3Mock = mockarS3Sucesso();

  const texto = await transcreverAudioTelegram("voice-file-1", "fake-token");

  assert.equal(texto, "olá, preciso de ajuda com um processo");
  assert.equal(s3Mock.mock.callCount(), 1);
});

test("job do Transcribe falha (FAILED) → retorna string vazia, não lança", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  mockarFetchAudio({});
  mockarS3Sucesso();
  mock.method(TranscribeClient.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof StartTranscriptionJobCommand) return {};
    if (cmd instanceof GetTranscriptionJobCommand) {
      return { TranscriptionJob: { TranscriptionJobStatus: "FAILED", FailureReason: "áudio corrompido" } };
    }
    throw new Error("Command não mockado");
  });

  const texto = await transcreverAudioTelegram("voice-file-2", "fake-token");

  assert.equal(texto, "");
});

test("sem token → retorna vazio sem tentar baixar (mesmo guard do WhatsApp)", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("não deveria chamar a Bot API sem token");
  });

  const texto = await transcreverAudioTelegram("voice-file-3", undefined);

  assert.equal(texto, "");
  assert.equal(fetchMock.mock.callCount(), 0);
});

// ── Guard estático: audioId tratado ANTES de mediaId, sem gate de contexto ──
// (diferente de foto/documento, que só baixa se a pergunta pendente for
// tipoPergunta "documento" — áudio é aceito em qualquer ponto da conversa,
// igual ao WhatsApp em processarMensagemWhatsApp).

test("processarMensagemTelegram: audioId é tratado ANTES de mediaId e SEM checar tipoPerguntaPendente", () => {
  const src = readFileSync(new URL("../src/core/channels/telegram.ts", import.meta.url), "utf8");
  const iFuncao = src.indexOf("export async function processarMensagemTelegram");
  const iAudio = src.indexOf("if (msg.audioId)", iFuncao);
  const iMedia = src.indexOf("if (msg.mediaId)", iFuncao);
  const iFimFuncao = src.indexOf("\nexport async function telegramRoutes", iFuncao);
  const trechoAudio = src.slice(iAudio, iMedia);

  assert.ok(iAudio > -1 && iMedia > -1 && iFimFuncao > -1, "trechos esperados não encontrados");
  assert.ok(iAudio < iMedia, "branch de áudio deve vir antes do branch de mídia/documento");
  assert.ok(
    !trechoAudio.includes("tipoPerguntaPendente"),
    "áudio não deve checar tipoPerguntaPendente — sem gate de contexto"
  );
  assert.match(
    trechoAudio,
    /não consegui entender o áudio/i,
    "deve responder o fallback amigável quando a transcrição vier vazia"
  );
});
