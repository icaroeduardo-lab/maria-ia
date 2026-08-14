// DATABASE_URL="" (mesmo padrão do CI real, ver CLAUDE.md): sem Postgres
// disponível aqui. Issue #20260214 — a rota trocou OCR ao vivo via Bedrock
// por leitura do resultado já pronto no S3 (lambda assíncrona de Textract).
// Diferente da versão anterior deste arquivo (que dependia de S3/Bedrock
// reais e por isso só testava guard estático pro caminho feliz), agora dá
// pra mockar S3Client.prototype.send (mesmo racional de mockarFetch em
// test/agendamentos-agendar.test.ts) e exercitar os cenários 200/404/500
// de ponta a ponta, sem tocar rede.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { montarApp } from "../src/api/app.js";

afterEach(() => {
  mock.reset();
});

// Mocka a listagem (buscarKeyDocumentoMaisRecente) e a leitura do JSON
// (lerResultadoTextractComRetry) na mesma função, discriminando pelo tipo do
// Command — os dois módulos usam S3Client.prototype.send.
function mockarS3(opts: { key?: string; jsonResultado?: unknown; erroLeitura?: string }) {
  return mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) {
      if (!opts.key) return { Contents: [] };
      return { Contents: [{ Key: opts.key, LastModified: new Date() }] };
    }
    if (cmd instanceof GetObjectCommand) {
      if (opts.erroLeitura) {
        const e = new Error(opts.erroLeitura) as Error & { name: string };
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => JSON.stringify(opts.jsonResultado) } };
    }
    throw new Error(`Command não mockado: ${cmd?.constructor?.name}`);
  });
}

test("sem sessionId nem _sessao no corpo → 400, nada tocado", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { nome: "Maria Silva", cpf: "11144477735" },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("sessionId presente mas nome/cpf ausentes (corpo e sem Postgres) → 422, não chega no S3", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { sessionId: `teste-422-${Date.now()}` },
  });
  assert.equal(res.statusCode, 422);
  await app.close();
});

test("aceita _sessao (nome do campo que o nó api do engine manda) no lugar de sessionId", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { _sessao: `teste-alias-${Date.now()}` }, // sem nome/cpf → cai no 422, não no 400
  });
  assert.equal(res.statusCode, 422, "deve reconhecer _sessao como sessionId (não deveria dar 400)");
  await app.close();
});

test("nenhum documento no bucket (S3 mockado vazio) → 404", async () => {
  mockarS3({});
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { sessionId: "teste-404", nome: "Maria Silva", cpf: "11144477735" },
  });
  await app.close();
  assert.equal(res.statusCode, 404);
});

test("documento encontrado + resultado da lambda pronto e batendo → 200 match true, status concluido", async () => {
  mockarS3({
    key: "documentos/teste-200/doc.jpg",
    jsonResultado: {
      extraido: {
        nome: { valor: "Maria Silva", confianca: "alta" },
        cpf: { valor: "11144477735", confianca: "alta" },
        dataNascimento: { valor: null, confianca: "nao_encontrado" },
      },
    },
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { sessionId: "teste-200", nome: "Maria Silva", cpf: "11144477735" },
  });
  await app.close();
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.match, true);
  assert.equal(corpo.status, "concluido");
  assert.equal(corpo.nome, undefined, "nunca deve reexpor o nome cru");
  assert.equal(corpo.cpf, undefined, "nunca deve reexpor o cpf cru");
});

test("resultado da lambda ainda não existe (NoSuchKey até o orçamento estourar) → 200 status processando, match false (fail-closed)", async () => {
  mockarS3({ key: "documentos/teste-proc/doc.pdf", erroLeitura: "ainda não existe" });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { sessionId: "teste-proc", nome: "Maria Silva", cpf: "11144477735", orcamentoMs: 30 },
  });
  await app.close();
  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.match, false);
  assert.equal(corpo.status, "processando");
});

test("lambda gravou erro de extração (ex: arquivo não reconhecido) → 500, mensagem fixa", async () => {
  mockarS3({
    key: "documentos/teste-erro/doc.bin",
    jsonResultado: { erro: "assinatura de arquivo não reconhecida" },
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/documentos/verificar",
    payload: { sessionId: "teste-erro", nome: "Maria Silva", cpf: "11144477735" },
  });
  await app.close();
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().erro, "falha ao processar o documento");
});

// ── Guard estático: cenários que precisam de S3/Bedrock reais ──────────────
const src = readFileSync(new URL("../src/api/routes/documentos.ts", import.meta.url), "utf8");

test("checagem de nome/cpf vem ANTES da busca no S3 (evita chamada cara/desnecessária)", () => {
  const idxCheck = src.indexOf("if (!nomeCadastro || !cpfCadastro)");
  const idxBusca = src.indexOf("buscarKeyDocumentoMaisRecente(");
  assert.ok(idxCheck > -1 && idxBusca > -1 && idxCheck < idxBusca);
});

test("busca no S3 vem ANTES da leitura do resultado do OCR — evita ler resultado sem ter arquivo", () => {
  const idxBusca = src.indexOf("buscarKeyDocumentoMaisRecente(");
  const idxLeitura = src.indexOf("lerResultadoTextractComRetry(");
  assert.ok(idxBusca > -1 && idxLeitura > -1 && idxBusca < idxLeitura);
});

test("não roda mais OCR ao vivo via Bedrock (extrairDadosDocumento) — lê resultado já pronto da lambda", () => {
  assert.doesNotMatch(src, /extrairDadosDocumento/);
});

test("LGPD: resposta de sucesso nunca inclui nome/cpf cru, só o resultado da comparação", () => {
  const idxReturn = src.indexOf("return { ...resultado, status:");
  assert.ok(idxReturn > -1);
  // a variável retornada vem só de compararComCadastro (match/detalhes) —
  // nunca reexpõe `extraido` (nome/cpf do OCR) nem nomeCadastro/cpfCadastro
  assert.match(src, /const resultado = compararComCadastro\(/);
  assert.doesNotMatch(src, /return\s*\{[^}]*\bextraido\b/s, "não deve devolver o objeto extraído bruto");
});

test("LGPD: nenhum console.log/error imprime nome/cpf em texto claro", () => {
  const logs = src.match(/console\.(log|error)\([^)]*\)/gs) ?? [];
  assert.ok(logs.length > 0, "esperava pelo menos 1 log");
  for (const l of logs) {
    assert.doesNotMatch(l, /\$\{nomeCadastro\}|\$\{cpfCadastro\}|\$\{extraido/, `log vaza PII: ${l}`);
  }
});

test("erros (404/422/500) não vazam detalhe interno — mensagem fixa, sem interpolar dado sensível", () => {
  assert.match(src, /erro: "nenhum documento encontrado para esta sessão"/);
  assert.match(src, /erro: "nome\/cpf ainda não coletados nesta sessão"/);
  assert.match(src, /erro: "falha ao processar o documento"/);
});
