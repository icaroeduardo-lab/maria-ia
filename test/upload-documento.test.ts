// DATABASE_URL="" (mesmo padrão do CI real, ver CLAUDE.md): não há Postgres
// disponível neste ambiente de teste. Os cenários que dependem de uma
// Conversation existente no banco (200 com PDF válido, 415 com sessão ativa,
// 404 com sessão inexistente-mas-tabela-consultável) NÃO são exercitáveis via
// .inject() aqui — mesma limitação já aceita pelo repo para outras rotas que
// tocam Postgres (ver test/conversas-lista.test.ts, test/flows-template.test.ts:
// "handlers exigem Postgres, não rodam live aqui" → guard estático de código).
// Este arquivo testa AO VIVO tudo que não depende de DB (400 sem sessionId,
// 429 de rate limit — que roda ANTES do check de banco por design, 503
// gracioso sem DATABASE_URL) e usa guard estático para os 415/404/200/LGPD.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { montarApp } from "../src/api/app.js";

// Monta um corpo multipart/form-data manualmente (sem lib externa) — campos
// de texto + 1 arquivo, na ordem em que os pares são passados.
function multipart(partes: Array<{ name: string; value: string } | { name: string; filename: string; contentType: string; content: Buffer }>) {
  const boundary = `----teste${Date.now()}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of partes) {
    if ("filename" in p) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`
      ));
      chunks.push(p.content);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// PDF real mínimo (header %PDF- válido) — usado nos testes que passam pelo
// parse do arquivo (rate limit / 400 não chegam a validar o conteúdo).
const pdfBuffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024, 0x41)]);

test("sem sessionId no multipart → 400, nada tocado", async () => {
  const app = await montarApp();
  const { body, contentType } = multipart([
    { name: "file", filename: "doc.pdf", contentType: "application/pdf", content: pdfBuffer },
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/upload-documento",
    headers: { "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("sem DATABASE_URL configurado → 503 (degrada gracioso, como /admin)", async () => {
  const app = await montarApp();
  const { body, contentType } = multipart([
    { name: "sessionId", value: `teste-503-${Date.now()}` },
    { name: "file", filename: "doc.pdf", contentType: "application/pdf", content: pdfBuffer },
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/upload-documento",
    headers: { "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 503);
  await app.close();
});

test("rate limit: N+1 uploads rápidos na mesma sessão → 429 (roda antes do check de banco)", async () => {
  const app = await montarApp();
  const sessionId = `teste-ratelimit-${Date.now()}`;
  let ultimoStatus = 0;
  // limite é 10/min (UPLOAD_RATE_LIMIT_MIN em upload-documento.ts) — 12 chamadas
  // garante estourar mesmo com alguma imprecisão de contagem
  for (let i = 0; i < 12; i++) {
    const { body, contentType } = multipart([
      { name: "sessionId", value: sessionId },
      { name: "file", filename: "doc.pdf", contentType: "application/pdf", content: pdfBuffer },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/upload-documento",
      headers: { "content-type": contentType },
      payload: body,
    });
    ultimoStatus = res.statusCode;
  }
  assert.equal(ultimoStatus, 429);
  await app.close();
});

// ── Guard estático: cenários que dependem de Postgres real (BDD 1/2/3 da
// issue) — mesma técnica de test/conversas-lista.test.ts para rotas que
// exigem banco indisponível neste ambiente de teste.
const src = readFileSync(new URL("../src/api/routes/upload-documento.ts", import.meta.url), "utf8");

test("BDD 3 (sessionId inexistente → 404): handler checa conversa + status active antes de tocar S3", () => {
  assert.match(src, /conversa\?\.status\s*!==\s*"active"/, "deve checar existência + status active");
  assert.match(src, /404/);
  const idxConversa = src.indexOf("prisma.conversation.findUnique");
  const idxSalvar = src.indexOf("salvarDocumento(");
  assert.ok(idxConversa > -1 && idxSalvar > -1 && idxConversa < idxSalvar, "checagem de conversa deve vir ANTES de salvar no S3");
});

test("BDD 2 (.exe com Content-Type spoofado → 415): handler usa magic bytes, não o Content-Type declarado", () => {
  assert.match(src, /mimeReal\(arquivo\.buffer\)/, "deve validar por magic bytes, não pelo mimetype declarado do multipart");
  assert.match(src, /415/);
  const idxMime = src.indexOf("mimeReal(arquivo.buffer)");
  const idxSalvar = src.indexOf("salvarDocumento(");
  assert.ok(idxMime > -1 && idxSalvar > -1 && idxMime < idxSalvar, "validação de magic bytes deve vir ANTES de salvar no S3");
});

test("BDD 1 (upload válido → 200): resposta nunca inclui URL/key do S3 (LGPD)", () => {
  const idxReturn = src.indexOf("return {");
  const trechoReturn = src.slice(idxReturn, src.indexOf("};", idxReturn));
  assert.doesNotMatch(trechoReturn, /url|Bucket|Key/i, "resposta não pode vazar URL/key do S3 — só metadado");
  assert.match(src, /nome.*tamanho.*mimeType|meta,/s);
});
