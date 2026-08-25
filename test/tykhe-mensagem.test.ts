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
import { graph as graphEstatico } from "../src/core/graph.js";

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
  assert.equal(
    body.tipoResposta,
    "sim_nao",
    "prompt de aceite da LGPD emite bloco boolean (lgpd.ts) — tipoEOpcoes deve achar esse bloco"
  );
  assert.deepEqual(body.opcoes, ["Sim", "Não"]);
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
  assert.equal(
    body2.tipoResposta,
    "texto",
    "'Me conte um pouco sobre o seu caso.' é pergunta de texto livre — sem bloco boolean/options, tipoEOpcoes deve cair no fallback 'texto'"
  );
  assert.equal("opcoes" in body2, false, "tipoResposta:'texto' não deve vir acompanhado de opcoes");
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
  assert.equal(
    ["sim_nao", "opcoes", "texto"].includes(body.tipoResposta),
    true,
    "tipoResposta sempre presente numa resposta de conversa normal"
  );
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
  assert.equal(body.tipoResposta, "texto", "fallback de falha de transcrição pede reenvio em texto livre");
  assert.equal("opcoes" in body, false);
});

// ── dadosConhecidos: semeia resultado_cpf/cpf quando a TYKHE já consultou o
// CPF no Verde por fora do motor da Maria (sem isso, node pp_set_idpessoa do
// fluxo "Pessoa Presa" leria {{resultado_cpf.dados.idPessoa}} vazio). Só faz
// efeito na 1ª chamada de um chatId (thread nova) — verificado direto no
// checkpoint do grafo estático (mesmo padrão de GET /conversations/:id/historico
// em admin.ts, que também lê graphEstatico.getState() pelo thread_id).

test("dadosConhecidos: 1ª chamada de um chatId novo semeia resultado_cpf/cpf em dadosColetados", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-dados-conhecidos-${Date.now()}-a`;

  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: {
      chatId,
      mensagem: "oi",
      dadosConhecidos: { cpf: "11122233344", idPessoa: 4242, nome: "Maria da Silva", email: "maria@example.com" },
    },
  });
  await app.close();

  assert.equal(res.statusCode, 200);

  const st = await graphEstatico.getState({ configurable: { thread_id: `tykhe:${chatId}` } });
  const coletados = (st.values?.dadosColetados ?? {}) as Record<string, string>;
  assert.equal(coletados.cpf, "11122233344", "cpf flat semeado (api_encaminhar precisa dele achatado)");
  const resultadoCpf = JSON.parse(coletados.resultado_cpf ?? "null");
  assert.equal(resultadoCpf.encontrado, true);
  assert.equal(
    resultadoCpf.dados.idPessoa,
    4242,
    "pp_set_idpessoa lê {{resultado_cpf.dados.idPessoa}} — precisa vir preenchido"
  );
  assert.equal(resultadoCpf.dados.nome, "Maria da Silva");
  assert.equal(resultadoCpf.dados.cpf, "11122233344");
  assert.equal(resultadoCpf.dados.email, "maria@example.com");
});

test("dadosConhecidos: 2ª chamada do MESMO chatId é ignorada — não sobrescreve o que já foi semeado", async () => {
  const app = await montarApp();
  const chatId = `teste-tykhe-dados-conhecidos-${Date.now()}-b`;

  // turno 1: thread nova, semeia idPessoa=1 / cpf original
  const r1 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: {
      chatId,
      mensagem: "oi",
      dadosConhecidos: { cpf: "11111111111", idPessoa: 1, nome: "Original" },
    },
  });
  assert.equal(r1.statusCode, 200);

  // turno 2: MESMO chatId (thread já existe), dadosConhecidos DIFERENTE no
  // body — deve ser ignorado (thread resume via updateState+invoke(null),
  // dadosIniciais só é aplicado no invoke inicial de thread nova)
  const r2 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: {
      chatId,
      mensagem: "true", // aceita LGPD, avança o turno
      dadosConhecidos: { cpf: "99999999999", idPessoa: 999, nome: "Outro Nome" },
    },
  });
  await app.close();

  assert.equal(r2.statusCode, 200);

  const st = await graphEstatico.getState({ configurable: { thread_id: `tykhe:${chatId}` } });
  const coletados = (st.values?.dadosColetados ?? {}) as Record<string, string>;
  assert.equal(coletados.cpf, "11111111111", "cpf da 1ª chamada permanece — 2ª chamada não pode sobrescrever");
  const resultadoCpf = JSON.parse(coletados.resultado_cpf ?? "null");
  assert.equal(resultadoCpf.dados.idPessoa, 1, "idPessoa da 1ª chamada permanece — 999 da 2ª deve ser ignorado");
  assert.equal(resultadoCpf.dados.nome, "Original");
});
