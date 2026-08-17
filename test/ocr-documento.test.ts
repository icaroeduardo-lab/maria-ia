process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  nomesCompativeis,
  cpfsCompativeis,
  compararComCadastro,
  datasCompativeis,
  buscarKeyDocumentoMaisRecente,
} from "../src/core/ocr-documento.js";

afterEach(() => {
  mock.reset();
});

// Card #20260203 — comparação tolerante de nome (normaliza acento/caixa,
// tolera abreviação/erro pequeno) e exata de CPF (só dígitos). Puro, sem
// tocar S3/Bedrock — mesmo racional de test/mask.test.ts.

test("nomesCompativeis: idêntico bate", () => {
  assert.equal(nomesCompativeis("Maria da Silva", "Maria da Silva"), true);
});

test("nomesCompativeis: tolera acento e caixa", () => {
  assert.equal(nomesCompativeis("joao pereira", "João Pereira"), true);
  assert.equal(nomesCompativeis("MARIA COSTA", "maria costa"), true);
});

test("nomesCompativeis: tolera abreviação (prefixo)", () => {
  assert.equal(nomesCompativeis("Joao S. Pereira", "João Silva Pereira"), true);
});

test("nomesCompativeis: tolera 1 token divergente em nome composto (3+ tokens)", () => {
  assert.equal(nomesCompativeis("Maria de Souza Costa", "Maria Aparecida Souza Costa"), true);
});

test("nomesCompativeis: nome completamente diferente não bate", () => {
  assert.equal(nomesCompativeis("Maria da Silva", "Joao Pereira"), false);
});

test("nomesCompativeis: cadastro com nome abreviado bate contra documento com nome legal completo", () => {
  // bug real achado 2026-08-12 (CNH-e real): cadastro "Icaro Albar" (2
  // tokens) vs documento "Icaro Luiz Albar Eduardo" (4 tokens) — antes do
  // fix, 2/4=0.5 ficava abaixo do limiar 0.7; agora divide pelo MENOR nome.
  assert.equal(nomesCompativeis("Icaro Albar", "Icaro Luiz Albar Eduardo"), true);
  // mesma lógica no sentido inverso (documento abreviado, cadastro completo)
  assert.equal(nomesCompativeis("Icaro Luiz Albar Eduardo", "Icaro Albar"), true);
});

test("nomesCompativeis: nome curto genuinamente diferente ainda não bate mesmo com 1 token em comum", () => {
  assert.equal(nomesCompativeis("Icaro Albar", "Icaro Luiz Souza Eduardo"), false);
});

test("nomesCompativeis: vazio nunca bate", () => {
  assert.equal(nomesCompativeis("", "Maria Silva"), false);
  assert.equal(nomesCompativeis("Maria Silva", ""), false);
  assert.equal(nomesCompativeis(null, undefined), false);
});

test("cpfsCompativeis: exige exatamente os mesmos 11 dígitos", () => {
  assert.equal(cpfsCompativeis("111.444.777-35", "11144477735"), true);
  assert.equal(cpfsCompativeis("11144477735", "11144477736"), false);
});

test("cpfsCompativeis: formato inválido (não 11 dígitos) nunca bate", () => {
  assert.equal(cpfsCompativeis("123", "123"), false);
  assert.equal(cpfsCompativeis("", ""), false);
});

test("compararComCadastro: match true só quando nome E cpf batem", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "111.444.777-35", dataNascimento: null },
    "Joao Pereira",
    "11144477735"
  );
  assert.equal(r.match, true);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: true, dataNascimento_ok: null });
});

test("compararComCadastro: cpf divergente derruba match mesmo com nome ok", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "11144477735", dataNascimento: null },
    "Joao Pereira",
    "22233344456"
  );
  assert.equal(r.match, false);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: false, dataNascimento_ok: null });
});

test("compararComCadastro: OCR sem extrair nada nunca dá match", () => {
  const r = compararComCadastro(
    { nome: null, cpf: null, dataNascimento: null },
    "Joao Pereira",
    "11144477735"
  );
  assert.equal(r.match, false);
  assert.deepEqual(r.detalhes, { nome_ok: false, cpf_ok: false, dataNascimento_ok: null });
});

test("compararComCadastro: data de nascimento no documento bate com o cadastro (ISO)", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "11144477735", dataNascimento: "15/03/1990" },
    "Joao Pereira",
    "11144477735",
    "1990-03-15"
  );
  assert.equal(r.match, true);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: true, dataNascimento_ok: true });
});

test("compararComCadastro: data de nascimento divergente derruba match", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "11144477735", dataNascimento: "15/03/1990" },
    "Joao Pereira",
    "11144477735",
    "1991-03-15"
  );
  assert.equal(r.match, false);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: true, dataNascimento_ok: false });
});

test("compararComCadastro: documento sem data de nascimento não derruba match", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "11144477735", dataNascimento: null },
    "Joao Pereira",
    "11144477735",
    "1990-03-15"
  );
  assert.equal(r.match, true);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: true, dataNascimento_ok: null });
});

test("datasCompativeis: cadastro sem data de nascimento retorna null (não é divergência)", () => {
  // bug real 2026-08-14 (achado pelo agente `fluxos`): cadastro sem
  // dataNascimento (ex: fluxo "Atualizar Dados" derivado de API do Gateway
  // Verde que não devolve o campo) caía no branch de "false", derrubando o
  // match mesmo com documento trazendo data legível e nome/CPF batendo.
  assert.equal(datasCompativeis(undefined, "15/03/1990"), null);
  assert.equal(datasCompativeis(null, "15/03/1990"), null);
  assert.equal(datasCompativeis("", "15/03/1990"), null);
});

test("compararComCadastro: cadastro sem data de nascimento não derruba match", () => {
  const r = compararComCadastro(
    { nome: "João Pereira", cpf: "11144477735", dataNascimento: "15/03/1990" },
    "Joao Pereira",
    "11144477735",
    undefined
  );
  assert.equal(r.match, true);
  assert.deepEqual(r.detalhes, { nome_ok: true, cpf_ok: true, dataNascimento_ok: null });
});

// ── buscarKeyDocumentoMaisRecente: retry/backoff do ListObjectsV2 ──────────
// Achado em produção 2026-08-14: política IAM confirmada correta (simulate-
// principal-policy allowed, sem PutRolePolicy no CloudTrail) mas algumas
// chamadas reais voltaram AccessDenied e depois passaram a funcionar
// sozinhas — cheiro de instabilidade transitória da AWS, não bug nosso.
// Blindagem defensiva: retry curto tratando erro transitório (AccessDenied
// incluso), sem mascarar falha persistente. backoffMs baixo aqui só pra não
// deixar o teste lento — o comportamento default de produção é 300ms/800ms.

function erroS3(nome: string): Error {
  const e = new Error(nome) as Error & { name: string };
  e.name = nome;
  return e;
}

test("buscarKeyDocumentoMaisRecente: sucesso na 2ª tentativa depois de AccessDenied transitório", async () => {
  let chamadas = 0;
  const sendMock = mock.method(S3Client.prototype, "send", async (cmd: unknown) => {
    assert.ok(cmd instanceof ListObjectsV2Command);
    chamadas++;
    if (chamadas === 1) throw erroS3("AccessDenied");
    return { Contents: [{ Key: "documentos/s1/doc.jpg", LastModified: new Date() }] };
  });

  const key = await buscarKeyDocumentoMaisRecente("s1", { backoffMs: [5, 5] });

  assert.equal(key, "documentos/s1/doc.jpg");
  assert.equal(sendMock.mock.callCount(), 2);
});

test("buscarKeyDocumentoMaisRecente: AccessDenied persistente esgota tentativas e propaga o erro (não mascara)", async () => {
  const sendMock = mock.method(S3Client.prototype, "send", async () => {
    throw erroS3("AccessDenied");
  });

  await assert.rejects(
    buscarKeyDocumentoMaisRecente("s1", { tentativas: 3, backoffMs: [5, 5] }),
    /AccessDenied/
  );
  assert.equal(sendMock.mock.callCount(), 3);
});

test("buscarKeyDocumentoMaisRecente: erro não-transitório (ex: NoSuchBucket) propaga na 1ª tentativa, sem retry", async () => {
  const sendMock = mock.method(S3Client.prototype, "send", async () => {
    throw erroS3("NoSuchBucket");
  });

  await assert.rejects(
    buscarKeyDocumentoMaisRecente("s1", { tentativas: 3, backoffMs: [5, 5] }),
    /NoSuchBucket/
  );
  assert.equal(sendMock.mock.callCount(), 1);
});
