// Cobre POST /api/agendamentos/consultar + /api/agendamentos/detalhe
// (src/api/routes/agendamentos.ts) — foco no campo idAssunto (issue
// maria-ia#20260234): o Verde manda assunto:{id,nome} na lista de
// agendamentos, e o detalhe precisa repassar esse id adiante pro fluxo poder
// chamar /api/assunto/documentos sem bater de novo no Verde. GATEWAY_VERDE_URL
// fake + mock de global.fetch, mesmo padrão de agendamentos-agendar.test.ts.
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

test("consultar: assunto.id do Verde vira idAssunto no agendamento enxuto", { skip: SEM_BANCO }, async () => {
  mockarFetch(() =>
    Response.json({
      dados: {
        agendamentos: [
          {
            numeroAgendamento: 5532300,
            status: "aberto",
            dataAgendamento: "20/08/2026",
            orgao: { nome: "DPGE Centro" },
            assunto: { id: 3151, nome: "Divórcio consensual" },
          },
        ],
      },
    })
  );
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/consultar",
    payload: { cpf: "17218415717" },
  });
  await app.close();

  const body = res.json();
  assert.equal(body.tem_agendamentos, true);
  assert.equal(body.agendamentos[0].idAssunto, 3151);
});

test("detalhe: resolve por índice e repassa idAssunto adiante (mesmo JSON que /consultar devolveu)", {
  skip: SEM_BANCO,
}, async () => {
  const app = await montarApp();
  const agendamentos = JSON.stringify({
    agendamentos: [
      {
        id: "5532300",
        tipo: "Divórcio consensual",
        data: "20/08/2026",
        local: "DPGE Centro",
        status: "aberto",
        idAssunto: 3151,
      },
    ],
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/detalhe",
    payload: { agendamento_sel: "1", agendamentos },
  });
  await app.close();

  assert.deepEqual(res.json(), {
    encontrado: true,
    id: "5532300",
    tipo: "Divórcio consensual",
    data: "20/08/2026",
    local: "DPGE Centro",
    status: "aberto",
    idAssunto: 3151,
  });
});

test("detalhe: agendamento sem idAssunto (fallback local) → idAssunto null", {
  skip: SEM_BANCO,
}, async () => {
  const app = await montarApp();
  const agendamentos = JSON.stringify({
    agendamentos: [{ id: "abc123", tipo: "Atendimento", data: "20/08/2026", local: null, status: "aberto" }],
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/agendamentos/detalhe",
    payload: { agendamento_sel: "1", agendamentos },
  });
  await app.close();

  assert.equal(res.json().idAssunto, null);
});
