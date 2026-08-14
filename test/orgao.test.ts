// GATEWAY_VERDE_URL fake + mock de global.fetch: cobre a lógica de mapeamento
// de src/api/routes/orgao.ts (nunca testada antes — zero cobertura). Sem
// isso, o único teste indireto era "gateway fora do ar" via GATEWAY_VERDE_URL="",
// que nunca exercita a desambiguação agendamento-vs-encaminhamento nem o
// mapeamento de campos. Não depende de banco (orgao.ts não usa prisma).
process.env.GATEWAY_VERDE_URL = "http://fake-gateway.test";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { montarApp } from "../src/api/app.js";

function mockarFetch(handler: (url: string) => Response) {
  return mock.method(globalThis, "fetch", async (input: string | URL) => handler(String(input)));
}

afterEach(() => {
  mock.reset();
});

test("primeiro-atendimento: idPessoa/idAssunto ausentes → tem_orgao false, sem chamar o gateway", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/primeiro-atendimento",
    payload: {},
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tem_orgao, false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("primeiro-atendimento: prefere órgão de AGENDAMENTO mesmo quando encaminhamento vem primeiro na lista (confirmado ao vivo em homolog)", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        { id: 10, nome: "Núcleo Encaminhamento", tipoAtendimento: "Encaminhamento" },
        {
          id: 20,
          nome: "Núcleo Agendamento Presencial",
          tipoAtendimento: "Agendamento Presencial",
          enderecos: [{ idLocalAtendimento: 99, logradouro: "Rua X", municipio: "Rio de Janeiro" }],
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 555, data: "20/08/2026", hora: "10:00" },
              { idIntervalo: 556, data: "21/08/2026", hora: "11:00" },
            ],
          },
        },
      ],
    })
  );
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/primeiro-atendimento",
    payload: { idPessoa: 2973942, idAssunto: 3151 },
  });
  await app.close();

  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(body.tem_orgao, true);
  assert.equal(body.orgao_id, 20);
  assert.equal(body.tipo_atendimento, "agendamento");
  assert.equal(body.idLocalAtendimento, 99);
  assert.equal(body.primeira_vaga_intervalo, 555);
  assert.equal(body.primeira_vaga_data, "20/08/2026");
  assert.equal(body.primeira_vaga_hora, "10:00");
});

test("primeiro-atendimento: só órgão de encaminhamento disponível → tipo_atendimento encaminhamento, sem vaga", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [{ id: 30, nome: "Núcleo Remoto", tipoAtendimento: "Encaminhamento" }],
    })
  );
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/primeiro-atendimento",
    payload: { idPessoa: 1, idAssunto: 2 },
  });
  await app.close();

  const body = res.json();
  assert.equal(body.tem_orgao, true);
  assert.equal(body.tipo_atendimento, "encaminhamento");
  assert.equal(body.primeira_vaga_data, null);
});

test("primeiro-atendimento: gateway fora do ar → tem_orgao false, sem lançar", async () => {
  mockarFetch(() => new Response(null, { status: 500 }));
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/primeiro-atendimento",
    payload: { idPessoa: 1, idAssunto: 2 },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tem_orgao, false);
});

test("primeiro-atendimento: envia complemento na query quando informado", async () => {
  let urlChamada = "";
  mockarFetch((url) => {
    urlChamada = url;
    return Response.json({ dados: [] });
  });
  const app = await montarApp();
  await app.inject({
    method: "POST",
    url: "/api/orgao/primeiro-atendimento",
    payload: { idPessoa: 1, idAssunto: 2, complemento: "urbano" },
  });
  await app.close();

  assert.match(urlChamada, /idPessoa=1/);
  assert.match(urlChamada, /idAssunto=2/);
  assert.match(urlChamada, /complemento=urbano/);
});
