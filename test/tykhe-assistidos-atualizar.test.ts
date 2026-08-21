// Cobre POST /api/tykhe/assistidos/atualizar (src/api/routes/tykhe/assistidos.ts)
// — endpoint desmembrado pra Tykhe chamar, sem autenticação (protótipo).
// GATEWAY_VERDE_URL fake + mock de global.fetch pra exercitar o caminho feliz
// (Verde) sem depender de banco — igual test/agendamentos-agendar.test.ts.
process.env.GATEWAY_VERDE_URL = "http://fake-gateway.test";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { montarApp } from "../src/api/app.js";

function mockarFetch(handler: (url: string, init?: RequestInit) => Response) {
  return mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init)
  );
}

afterEach(() => {
  mock.reset();
});

test("200: campo válido → atualiza via Verde (GET pra completar email, PUT com o novo telefone)", async () => {
  mockarFetch((url, init) => {
    if (!init || init.method === undefined) {
      // GET /api/assistido/{cpf} — consultarAssistidoVerde, usado pra completar
      // o email exigido pelo PUT (a Tykhe manda só o campo escolhido).
      assert.match(url, /\/api\/assistido\/12345678900$/);
      return Response.json({ dados: { nome: "Fulano de Tal", email: "fulano@teste.dperj.rj.gov.br" } });
    }
    // PUT /api/assistido/{cpf} — atualizarAssistidoVerde
    assert.equal(init.method, "PUT");
    assert.match(url, /\/api\/assistido\/12345678900$/);
    return new Response(null, { status: 204 });
  });

  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/assistidos/atualizar",
    payload: { cpf: "123.456.789-00", campo: "telefone", valor: "21999998888" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    sucesso: true,
    dados: { cpf: "12345678900", telefone: "21999998888" },
  });
});

test("400: campo fora do enum aceito", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/assistidos/atualizar",
    payload: { cpf: "12345678900", campo: "nomeMae", valor: "Maria" },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().sucesso, false);
  assert.match(res.json().erro, /campo inválido/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("400: sem cpf", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/tykhe/assistidos/atualizar",
    payload: { campo: "telefone", valor: "21999998888" },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { sucesso: false, erro: "cpf inválido" });
  assert.equal(fetchMock.mock.callCount(), 0);
});
