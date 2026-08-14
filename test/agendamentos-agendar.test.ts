// Cobre POST /api/agendamentos/verificar-duplicados e /api/agendamentos/agendar
// (src/api/routes/agendamentos.ts) — nunca testados antes. GATEWAY_VERDE_URL
// fake + mock de global.fetch pra exercitar o mapeamento sem bater na rede.
//
// agendamentosFlowRoutes registra um preHandler que 503 TODA rota do arquivo
// quando `prisma` é null (mesmo sem essas duas rotas tocarem o banco) — por
// isso, igual test/elegibilidade.test.ts, os testes daqui são pulados (skip,
// não falham) no modo padrão do CI (DATABASE_URL="", ver CLAUDE.md).
process.env.GATEWAY_VERDE_URL = "http://fake-gateway.test";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { montarApp } from "../src/api/app.js";

const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";

function mockarFetch(handler: (url: string, init?: RequestInit) => Response) {
  return mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init)
  );
}

afterEach(() => {
  mock.reset();
});

test("verificar-duplicados: idPessoa/idAssunto ausentes → tem_duplicado false, sem chamar o gateway", {
  skip: SEM_BANCO,
}, async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/verificar-duplicados",
    payload: {},
  });
  await app.close();

  assert.equal(res.json().tem_duplicado, false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("verificar-duplicados: já existe agendamento pro mesmo assunto → tem_duplicado true com id e data", {
  skip: SEM_BANCO,
}, async () => {
  let urlChamada = "";
  mockarFetch((url) => {
    urlChamada = url;
    return Response.json({
      dados: { agendamentos: [{ id: 5532300, dataAgendamento: "20/08/2026 10:00" }] },
    });
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/verificar-duplicados",
    payload: { idPessoa: 2973942, idAssunto: 3151 },
  });
  await app.close();

  assert.match(urlChamada, /idPessoa=2973942/);
  assert.match(urlChamada, /idAssunto=3151/);
  assert.deepEqual(res.json(), {
    tem_duplicado: true,
    idAgendamentoDuplicado: 5532300,
    dataDuplicado: "20/08/2026 10:00",
  });
});

test("verificar-duplicados: nenhum agendamento existente → tem_duplicado false", {
  skip: SEM_BANCO,
}, async () => {
  mockarFetch(() => Response.json({ dados: { agendamentos: [] } }));
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/verificar-duplicados",
    payload: { idPessoa: 1, idAssunto: 2 },
  });
  await app.close();

  assert.deepEqual(res.json(), {
    tem_duplicado: false,
    idAgendamentoDuplicado: null,
    dataDuplicado: null,
  });
});

test("agendar: monta o payload certo pro gateway (idPessoa/idOrgao/idAssunto/idIntervalo/dataVaga/resumoAtendimento/fluxoAtendimento) e mapeia sucesso+id", {
  skip: SEM_BANCO,
}, async () => {
  let corpoEnviado: unknown;
  mockarFetch((_url, init) => {
    corpoEnviado = JSON.parse(String(init?.body));
    return Response.json({ dados: { id: 5532379 } }, { status: 201 });
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/agendar",
    payload: {
      idPessoa: 2973942,
      idOrgao: 20,
      idAssunto: 3151,
      idIntervalo: 555,
      dataVaga: "20/08/2026 10:00",
      resumoAtendimento: "Pedido de divórcio consensual",
    },
  });
  await app.close();

  assert.deepEqual(corpoEnviado, {
    idPessoa: 2973942,
    idOrgao: 20,
    idAssunto: 3151,
    idIntervalo: 555,
    dataVaga: "20/08/2026 10:00",
    resumoAtendimento: "Pedido de divórcio consensual",
    fluxoAtendimento: "PRIMEIRO_ATENDIMENTO",
    textoComplemento: "",
  });
  assert.deepEqual(res.json(), { sucesso: true, idAgendamento: 5532379 });
});

test("agendar: gateway recusa (400/422/500) → sucesso false, idAgendamento null, sem lançar", {
  skip: SEM_BANCO,
}, async () => {
  mockarFetch(() => new Response(null, { status: 422 }));
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/agendar",
    payload: { idPessoa: 1, idOrgao: 2, idAssunto: 3, idIntervalo: 4, dataVaga: "x", resumoAtendimento: "y" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { sucesso: false, idAgendamento: null });
});
