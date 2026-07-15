// DATABASE_URL="" (mesmo padrão do CI real, ver CLAUDE.md): sem Postgres, o
// preHandler de adminRoutes já devolve 503 pra TODA rota /admin/* antes de
// chegar em autenticar/exigirAdmin — inclusive as novas /test-chat e
// /test-chat/upload (issue #82). Os cenários de sucesso (200 com
// tipoPerguntaPendente, 404 flow inexistente, 422 flow inválido, 415 magic
// bytes) exigem Postgres real e não são exercitáveis via .inject() aqui —
// mesma limitação já aceita pelo repo (ver test/flows-template.test.ts,
// test/upload-documento.test.ts). Este arquivo testa AO VIVO o degrade
// gracioso sem banco e usa guard estático de código pro resto (BDD da issue).
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { montarApp } from "../src/api/app.js";

// Monta um corpo multipart/form-data manualmente (sem lib externa) — mesmo
// helper de test/upload-documento.test.ts.
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

const pdfBuffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1024, 0x41)]);

test("POST /admin/test-chat sem DATABASE_URL → 503 (degrada gracioso, como o resto de /admin)", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/admin/test-chat",
    payload: { sessionId: `teste-503-${Date.now()}` },
  });
  assert.equal(res.statusCode, 503);
  await app.close();
});

test("POST /admin/test-chat/upload sem DATABASE_URL → 503, mesmo sem JWT (503 roda antes de autenticar)", async () => {
  const app = await montarApp();
  const { body, contentType } = multipart([
    { name: "sessionId", value: `teste-503-${Date.now()}` },
    { name: "file", filename: "doc.pdf", contentType: "application/pdf", content: pdfBuffer },
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/admin/test-chat/upload",
    headers: { "content-type": contentType },
    payload: body,
  });
  assert.equal(res.statusCode, 503);
  await app.close();
});

// ── Guard estático: cenários que dependem de Postgres real ────────────────
const src = readFileSync(new URL("../src/api/routes/admin.ts", import.meta.url), "utf8");

test("tipoPerguntaPendente entra na resposta de /test-chat via montarRespostaTeste (não duplicado)", () => {
  const idxHelper = src.indexOf("async function montarRespostaTeste(");
  assert.ok(idxHelper > -1, "helper compartilhado montarRespostaTeste deve existir");
  const idxFimHelper = src.indexOf("\n  }\n", idxHelper);
  const helper = src.slice(idxHelper, idxFimHelper);
  assert.match(helper, /tipoPerguntaPendente/, "helper deve calcular tipoPerguntaPendente");
  assert.match(helper, /resolverTipoPergunta\(/, "deve usar resolverTipoPergunta (extraída em chat.ts, issue #82)");

  // os dois handlers usam o MESMO helper — não duplicam a lógica de done/coletados/resumo/metadados
  const idxTestChat = src.indexOf('app.post("/test-chat",');
  const idxUpload = src.indexOf('app.post("/test-chat/upload",');
  assert.ok(idxTestChat > -1 && idxUpload > -1, "as duas rotas devem existir");
  const handlerTestChat = src.slice(idxTestChat, idxUpload);
  const handlerUpload = src.slice(idxUpload, idxUpload + 3000);
  assert.match(handlerTestChat, /montarRespostaTeste\(/, "/test-chat deve reusar o helper");
  assert.match(handlerUpload, /montarRespostaTeste\(/, "/test-chat/upload deve reusar o helper");
});

test("/test-chat/upload usa magic bytes (mimeReal) ANTES de salvarDocumento — mesmo padrão da #74", () => {
  const idxUpload = src.indexOf('app.post("/test-chat/upload",');
  const idxFimUpload = src.indexOf("\n  });\n", idxUpload);
  const handler = src.slice(idxUpload, idxFimUpload);
  assert.match(handler, /mimeReal\(arquivo\.buffer\)/, "deve validar por magic bytes, não pelo mimetype declarado");
  assert.match(handler, /415/);
  const idxMime = handler.indexOf("mimeReal(arquivo.buffer)");
  const idxSalvar = handler.indexOf("salvarDocumento(");
  assert.ok(idxMime > -1 && idxSalvar > -1 && idxMime < idxSalvar, "validação de magic bytes deve vir ANTES de salvar no S3");
});

test("/test-chat/upload usa a MESMA fórmula de threadId que /test-chat (test:<flowId>:<sessionId>)", () => {
  const formulas = [...src.matchAll(/`test:\$\{flowId \?\? "static"\}:\$\{sessionId\}`/g)];
  assert.equal(formulas.length, 2, "a fórmula de threadId deve aparecer exatamente 2x (uma por handler)");
});

test("/test-chat/upload usa limite de 10MB via override por-request (req.parts({ limits })), não reregistra fastifyMultipart", () => {
  // /upload (imagens do builder) continua com o limite de 5MB no topo do arquivo
  assert.match(src, /fileSize:\s*5\s*\*\s*1024\s*\*\s*1024/, "/upload deve continuar com 5MB fixo");

  // @fastify/multipart usa fastify-plugin por baixo (decora a instância ROOT,
  // não encapsula) — reregistrar o plugin, mesmo dentro de um app.register()
  // aninhado, decora a MESMA instância root duas vezes e quebra o server
  // inteiro com FST_ERR_CTP_ALREADY_PRESENT (confirmado rodando a suite: toda
  // rota multipart do app, inclusive de outros arquivos, passou a falhar).
  // A forma correta de dar um limite diferente só pra uma rota é o override
  // por-request (req.parts({ limits })) — não um segundo app.register(fastifyMultipart).
  const idxUpload = src.indexOf('app.post("/test-chat/upload",');
  const idxFimUpload = src.indexOf("\n  });\n", idxUpload);
  const handler = src.slice(idxUpload, idxFimUpload);
  assert.match(handler, /req\.parts\(\{\s*limits:\s*\{\s*fileSize:\s*TAMANHO_MAX_BYTES/, "deve usar override por-request de limits, não re-registrar o plugin");

  // só 1 registro de fastifyMultipart no arquivo inteiro (o de 5MB no topo) —
  // um segundo registro (mesmo aninhado) derruba o server (fastify-plugin
  // decora a instância root, não encapsula)
  const registros = [...src.matchAll(/app\.register\(fastifyMultipart/g)];
  assert.equal(registros.length, 1, "fastifyMultipart deve ser registrado só 1x no arquivo inteiro");
});

test("/test-chat/upload é admin-only (exigirAdmin) e não exige Conversation", () => {
  const idxUpload = src.indexOf('app.post("/test-chat/upload",');
  const idxFimUpload = src.indexOf("\n  });\n", idxUpload);
  const handler = src.slice(idxUpload, idxFimUpload);
  assert.match(src.slice(idxUpload, idxUpload + 60), /exigirAdmin/, "rota deve exigir role admin");
  assert.doesNotMatch(handler, /conversation\.findUnique/i, "chat de teste não deve consultar Conversation");
});

test("BDD: sessionId ausente → 400; flow inexistente → 404; flow inválido → 422 (mesmo padrão de /test-chat)", () => {
  const idxUpload = src.indexOf('app.post("/test-chat/upload",');
  const idxFimUpload = src.indexOf("\n  });\n", idxUpload);
  const handler = src.slice(idxUpload, idxFimUpload);
  assert.match(handler, /!sessionId.*400|400.*sessionId/s);
  assert.match(handler, /carregarGrafoDeTeste\(/, "deve reusar o helper compartilhado de carregamento de flow");
});
