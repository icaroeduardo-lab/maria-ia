// Credenciais falsas ANTES de qualquer import (mesmo padrão de fluxo.test.ts):
// força os fallbacks determinísticos — o teste nunca chama Bedrock de verdade.
// DATABASE_URL vazia → prisma null → obterGraph() sempre usa o grafo estático
// (sem flow ativo no banco pra escolher).
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";
import { montarApp } from "../src/api/app.js";

// Cobre POST /api/tykhe/mensagem (src/api/routes/tykhe/mensagem.ts) — a peça
// central da integração Maria↔Tykhe: recebe 1 mensagem por chamada e roda o
// motor de verdade (processarMensagem/LangGraph) via HTTP.
//
// Os 2 primeiros turnos do grafo estático (saudacao → lgpd [interrupt] →
// lgpd_processar → primeira_mensagem [interrupt]) não chamam Bedrock — dá
// pra exercitar o multi-turn real (o ponto mais frágil: NUNCA invoke(input
// não-nulo) numa thread já existente, ver CLAUDE.md) sem mockar o LLM.

afterEach(() => {
  mock.reset();
});

test("1ª mensagem de um chatId novo inicia o fluxo (saudação + pergunta LGPD) e devolve em_andamento", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-${Date.now()}-a`;
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "oi" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.resposta, /Maria/);
  assert.match(body.resposta, /aceita os termos/);
  assert.equal(body.status, "em_andamento");
});

test("2ª mensagem do MESMO chatId continua a MESMA conversa — não reinicia do zero", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-${Date.now()}-b`;

  // turno 1: thread novo — dispara saudação + pergunta de aceite da LGPD
  const r1 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "oi" },
  });
  assert.equal(r1.statusCode, 200);
  assert.match(r1.json().resposta, /aceita os termos/);

  // turno 2: mesmo chatId, aceita a LGPD ("true" — id do botão boolean, ver
  // lgpd.ts:lgpdProcessar). Se a rota tivesse reiniciado o grafo (bug do
  // padrão multi-turn — invoke com input não-nulo em thread existente),
  // saudacao→lgpd rodariam de novo e a pergunta de aceite reapareceria aqui;
  // numa conversa que de fato resumiu do checkpoint, o próximo node visitado
  // é primeira_mensagem — resposta exatamente igual ao texto desse node.
  const r2 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "true" },
  });
  await app.close();

  assert.equal(r2.statusCode, 200);
  const body2 = r2.json();
  assert.doesNotMatch(
    body2.resposta,
    /aceita os termos/,
    "não pode repetir a pergunta de LGPD — indicaria reinício do grafo (bug de multi-turn)"
  );
  assert.equal(
    body2.resposta,
    "Me conte um pouco sobre o seu caso.",
    "2º turno resume do checkpoint (updateState + invoke(null)) — só o node primeira_mensagem roda, nada de saudacao/lgpd de novo"
  );
  assert.equal(body2.status, "em_andamento");
});

test("shape da resposta: { resposta, status, migrado } sempre presentes, categoria omitida quando ainda não há", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-${Date.now()}-c`;
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "oi" },
  });
  await app.close();

  const body = res.json();
  assert.equal(typeof body.resposta, "string");
  assert.equal(typeof body.status, "string");
  assert.equal(typeof body.migrado, "boolean");
  assert.equal(body.migrado, false, "sem categoria pessoa_presa/violencia_domestica ainda, migrado deve ser false");
  assert.equal("categoria" in body, false, "sem categoria coletada ainda, campo deve ser omitido");
});

test("400: chatId ausente", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { mensagem: "oi" },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  assert.match(res.json().erro, /chatId/);
});

test("400: nem mensagem nem audioUrl informados", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId: `teste-tykhe-${Date.now()}-d` },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  assert.match(res.json().erro, /mensagem ou audioUrl/);
});

// ── audioUrl: baixa + transcreve (pipeline compartilhado com o WhatsApp) ──
// S3Client/TranscribeClient mockados (AWS SDK), fetch mockado só pro download
// da URL de áudio e pro GET final do transcript — nunca chama AWS de verdade.

function mockarFetchAudioTykhe(opts: { transcriptUri: string; transcript: string }) {
  return mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url === "https://tykhe.example.com/audio123.ogg") {
      return new Response(new Uint8Array(Buffer.from("fake-ogg-bytes")), { status: 200 });
    }
    if (url === opts.transcriptUri) {
      return new Response(JSON.stringify({ results: { transcripts: [{ transcript: opts.transcript }] } }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  });
}

function mockarTranscribeCompleto(transcriptUri: string) {
  return mock.method(TranscribeClient.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof StartTranscriptionJobCommand) return {};
    if (cmd instanceof GetTranscriptionJobCommand) {
      return { TranscriptionJob: { TranscriptionJobStatus: "COMPLETED", Transcript: { TranscriptFileUri: transcriptUri } } };
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

test("audioUrl: baixa e transcreve antes de rodar o motor — texto transcrito vira a mensagem processada", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-audio-${Date.now()}`;

  // turno 1: texto normal, chega no prompt de LGPD (sem áudio envolvido)
  const r1 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "oi" },
  });
  assert.match(r1.json().resposta, /aceita os termos/);

  // turno 2: só audioUrl (sem mensagem) — transcrição mockada devolve "true",
  // o mesmo id do botão que aceita a LGPD (ver lgpd.ts:lgpdProcessar). Se a
  // rota não tivesse de fato transcrito e repassado o texto pro motor, o
  // grafo não teria como saber que o assistido aceitou — cairia em
  // lgpd_recusado, não em primeira_mensagem.
  const transcriptUri = "https://s3.example.com/transcript-tykhe.json";
  mockarFetchAudioTykhe({ transcriptUri, transcript: "true" });
  mockarTranscribeCompleto(transcriptUri);
  const s3Mock = mockarS3Sucesso();

  const r2 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, audioUrl: "https://tykhe.example.com/audio123.ogg" },
  });
  await app.close();

  assert.equal(r2.statusCode, 200);
  const body2 = r2.json();
  assert.equal(
    body2.resposta,
    "Me conte um pouco sobre o seu caso.",
    "transcrição virou 'true' → LGPD aceita → node primeira_mensagem — prova que o áudio foi baixado, transcrito e o texto seguiu pro motor"
  );
  assert.equal(s3Mock.mock.callCount(), 1, "pipeline de transcrição foi de fato acionado (upload pro S3)");
});

test("audioUrl: transcrição falha (job FAILED) → fallback amigável, sem tocar o motor", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-audio-falha-${Date.now()}`;

  mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url === "https://tykhe.example.com/audio-ruim.ogg") {
      return new Response(new Uint8Array(Buffer.from("fake-ogg-bytes")), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) return {};
    throw new Error("Command não mockado");
  });
  mock.method(TranscribeClient.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof StartTranscriptionJobCommand) return {};
    if (cmd instanceof GetTranscriptionJobCommand) {
      return { TranscriptionJob: { TranscriptionJobStatus: "FAILED", FailureReason: "áudio corrompido" } };
    }
    throw new Error("Command não mockado");
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, audioUrl: "https://tykhe.example.com/audio-ruim.ogg" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.resposta, /não consegui entender o áudio/);
  assert.equal(body.status, "em_andamento");
  assert.equal(body.migrado, false);
});
