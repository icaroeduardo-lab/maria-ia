process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  keyResultadoTextract,
  interpretarCorpo,
  lerResultadoTextractComRetry,
} from "../src/core/ocr-resultado-textract.js";

// Issue #20260214 — a rota /api/documentos/verificar passou a ler o
// resultado já pronto da lambda assíncrona de OCR (extraidos-textract/*.json)
// em vez de rodar Bedrock ao vivo. Mesmo racional de test/agendamentos-
// agendar.test.ts: mocka o SDK (aqui S3Client.prototype.send, lá
// globalThis.fetch) pra exercitar retry/backoff sem tocar rede.

afterEach(() => {
  mock.reset();
});

// ── keyResultadoTextract (pura) ─────────────────────────────────────────────
// Precisa bater com handler.ts#keyDeSaida exatamente (replicado, não
// importado — ver comentário no topo de ocr-resultado-textract.ts).

test("keyResultadoTextract: remove o prefixo documentos/ e adiciona extraidos-textract/ + .json", () => {
  assert.equal(
    keyResultadoTextract("documentos/wa:5521999999999/abc-123.pdf"),
    "extraidos-textract/wa:5521999999999/abc-123.pdf.json"
  );
});

test("keyResultadoTextract: sem o prefixo documentos/, ainda assim prefixa a saída (defesa)", () => {
  assert.equal(keyResultadoTextract("outra-pasta/x.jpg"), "extraidos-textract/outra-pasta/x.jpg.json");
});

// ── interpretarCorpo (pura) ─────────────────────────────────────────────────

test("interpretarCorpo: JSON de erro da lambda vira status erro_extracao com o detalhe", () => {
  const r = interpretarCorpo({ erro: "PDF com 30000000 bytes excede o teto de sanidade" });
  assert.equal(r.status, "erro_extracao");
  assert.match(r.detalheErro ?? "", /excede o teto/);
});

test("interpretarCorpo: só usa campos com confiança alta, baixa/nao_encontrado viram null", () => {
  const r = interpretarCorpo({
    extraido: {
      nome: { valor: "MARIA DA SILVA COSTA", confianca: "alta" },
      cpf: { valor: "11144477735", confianca: "baixa" },
      dataNascimento: { valor: null, confianca: "nao_encontrado" },
      linhasBrutas: [],
    },
  });
  assert.equal(r.status, "pronto");
  assert.deepEqual(r.dados, { nome: "MARIA DA SILVA COSTA", cpf: null, dataNascimento: null });
});

test("interpretarCorpo: todos os campos em alta confiança passam direto", () => {
  const r = interpretarCorpo({
    extraido: {
      nome: { valor: "Joao Pereira", confianca: "alta" },
      cpf: { valor: "111.444.777-35", confianca: "alta" },
      dataNascimento: { valor: "15/03/1990", confianca: "alta" },
      linhasBrutas: [],
    },
  });
  assert.deepEqual(r.dados, { nome: "Joao Pereira", cpf: "111.444.777-35", dataNascimento: "15/03/1990" });
});

test("interpretarCorpo: formato inesperado (nem erro nem extraido) vira erro_extracao", () => {
  const r = interpretarCorpo({ algumaCoisa: true });
  assert.equal(r.status, "erro_extracao");
  assert.match(r.detalheErro ?? "", /formato de resultado inesperado/);
});

// ── lerResultadoTextractComRetry (mocka S3Client.prototype.send) ───────────

function corpoJson(obj: unknown) {
  return { transformToString: async () => JSON.stringify(obj) };
}

function erroNaoEncontrado(): Error {
  const e = new Error("NoSuchKey") as Error & { name: string };
  e.name = "NoSuchKey";
  return e;
}

test("lerResultadoTextractComRetry: acha de primeira → status pronto, 1 chamada só", async () => {
  const sendMock = mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    assert.ok(cmd instanceof GetObjectCommand);
    return { Body: corpoJson({ extraido: { nome: { valor: "X", confianca: "alta" } } }) };
  });

  const r = await lerResultadoTextractComRetry("bucket-teste", "documentos/s1/doc.jpg", {
    orcamentoMs: 5000,
    intervaloMs: 10,
  });

  assert.equal(r.status, "pronto");
  assert.equal(sendMock.mock.callCount(), 1);
});

test("lerResultadoTextractComRetry: não encontrado nas 2 primeiras tentativas, acha na 3ª", async () => {
  let chamadas = 0;
  mock.method(S3Client.prototype, "send", async () => {
    chamadas++;
    if (chamadas < 3) throw erroNaoEncontrado();
    return { Body: corpoJson({ extraido: { cpf: { valor: "11144477735", confianca: "alta" } } }) };
  });

  const r = await lerResultadoTextractComRetry("bucket-teste", "documentos/s1/doc.jpg", {
    orcamentoMs: 5000,
    intervaloMs: 5,
  });

  assert.equal(r.status, "pronto");
  assert.equal(chamadas, 3);
});

test("lerResultadoTextractComRetry: nunca aparece dentro do orçamento → status ainda_processando (fallback, não trava)", async () => {
  mock.method(S3Client.prototype, "send", async () => {
    throw erroNaoEncontrado();
  });

  const r = await lerResultadoTextractComRetry("bucket-teste", "documentos/s1/doc.pdf", {
    orcamentoMs: 30,
    intervaloMs: 10,
  });

  assert.equal(r.status, "ainda_processando");
  assert.equal(r.dados, undefined);
});

test("lerResultadoTextractComRetry: erro que NÃO é 'não encontrado' propaga na hora (não fica em retry loop)", async () => {
  mock.method(S3Client.prototype, "send", async () => {
    const e = new Error("AccessDenied") as Error & { name: string };
    e.name = "AccessDenied";
    throw e;
  });

  await assert.rejects(
    lerResultadoTextractComRetry("bucket-teste", "documentos/s1/doc.pdf", {
      orcamentoMs: 5000,
      intervaloMs: 10,
    }),
    /AccessDenied/
  );
});
