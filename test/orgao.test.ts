// GATEWAY_VERDE_URL fake + mock de global.fetch: cobre a árvore de decisão
// nova de src/api/routes/orgao.ts (reescrita completa — descartou a lógica
// antiga de "prefere agendamento sobre encaminhamento, retorna só a 1ª
// vaga"). Sem isso, o único teste indireto seria "gateway fora do ar" via
// GATEWAY_VERDE_URL="", que nunca exercita a regra real. Não depende de
// banco (orgao.ts não usa prisma).
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

async function chamarPrimeiroAtendimento(payload: Record<string, unknown>) {
  const app = await montarApp();
  const res = await app.inject({ method: "POST", url: "/api/orgao/primeiro-atendimento", payload });
  await app.close();
  return res;
}

test("primeiro-atendimento: idPessoa/idAssunto ausentes → sem vaga, sem chamar o gateway", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const res = await chamarPrimeiroAtendimento({});

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.semVagaDisponivel, true);
  assert.equal(body.perguntarTipo, false);
  assert.equal(body.tipoDefault, null);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("primeiro-atendimento: gateway fora do ar → sem vaga, sem lançar", async () => {
  mockarFetch(() => new Response(null, { status: 500 }));
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.semVagaDisponivel, true);
  assert.equal(body.presencial.temOpcao, false);
  assert.equal(body.remoto.temOpcao, false);
});

test("primeiro-atendimento: nenhuma entrada com vaga → semVagaDisponivel true", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 10,
          nome: "Núcleo A",
          tipoAtendimento: "Agendamento Presencial",
          vagasDisponiveis: { vagasDisponiveis: [] },
        },
        {
          id: 10,
          nome: "Núcleo A",
          tipoAtendimento: "Agendamento Remoto",
          vagasDisponiveis: { vagasDisponiveis: [] },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.semVagaDisponivel, true);
  assert.equal(body.perguntarTipo, false);
  assert.equal(body.tipoDefault, null);
  assert.equal(body.presencial.temOpcao, false);
  assert.equal(body.remoto.temOpcao, false);
});

test("primeiro-atendimento: entrada com vagasDisponiveis ausente (não só vazio) também é ignorada", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [{ id: 10, nome: "Núcleo Sem Vaga", tipoAtendimento: "Agendamento Presencial" }],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.semVagaDisponivel, true);
});

test("primeiro-atendimento: só presencial, 1 unidade → pula pergunta de tipo E de unidade, vagas prontas", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 30,
          nome: "Núcleo Único",
          tipoAtendimento: "Agendamento Presencial",
          enderecos: [{ bairro: "Méier", municipio: "Rio de Janeiro" }],
          vagasDisponiveis: { vagasDisponiveis: [{ idIntervalo: 555, data: "20/08/2026", hora: "10:00" }] },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.semVagaDisponivel, false);
  assert.equal(body.perguntarTipo, false);
  assert.equal(body.tipoDefault, "presencial");
  assert.equal(body.presencial.temOpcao, true);
  assert.equal(body.presencial.perguntarUnidade, false);
  assert.equal(body.presencial.unidades.length, 1);
  assert.equal(body.presencial.unidades[0].id, 30);
  assert.equal(body.presencial.unidades[0].bairro, "Méier");
  assert.deepEqual(body.presencial.vagasUnicaUnidade, [
    { data: "20/08/2026", horarios: [{ idIntervalo: 555, hora: "10:00" }], listaHorarios: "1. 10:00" },
  ]);
  assert.equal(body.presencial.listaDatasUnicaUnidade, "1. 20/08/2026");
  assert.equal(body.remoto.temOpcao, false);
});

test("primeiro-atendimento: vagas vêm agrupadas por data (2 telas: escolhe data, depois horário) — várias horas no mesmo dia + dias diferentes", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 30,
          nome: "Núcleo Único",
          tipoAtendimento: "Agendamento Presencial",
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 1, data: "18/08/2026", hora: "08:30" },
              { idIntervalo: 2, data: "18/08/2026", hora: "10:00" },
              { idIntervalo: 3, data: "19/08/2026", hora: "08:30" },
            ],
          },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.deepEqual(body.presencial.vagasUnicaUnidade, [
    {
      data: "18/08/2026",
      horarios: [
        { idIntervalo: 1, hora: "08:30" },
        { idIntervalo: 2, hora: "10:00" },
      ],
      listaHorarios: "1. 08:30\n2. 10:00",
    },
    { data: "19/08/2026", horarios: [{ idIntervalo: 3, hora: "08:30" }], listaHorarios: "1. 08:30" },
  ]);
  // Lista de DATAS pronta (bug relatado 2026-08-14: template hardcoded do
  // fluxo mostrava slots vazios quando tinha menos itens que o cap fixo) —
  // 1 linha por data real, numerada, sem linha em branco.
  assert.equal(body.presencial.listaDatasUnicaUnidade, "1. 18/08/2026\n2. 19/08/2026");
});

test("primeiro-atendimento: só presencial, várias unidades → pula pergunta de tipo, PERGUNTA unidade, lista embutida com vagas", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 10,
          nome: "Núcleo A",
          tipoAtendimento: "Agendamento Presencial",
          enderecos: [{ bairro: "Méier", municipio: "Rio de Janeiro" }],
          vagasDisponiveis: { vagasDisponiveis: [{ idIntervalo: 1, data: "18/08/2026", hora: "08:00" }] },
        },
        {
          id: 20,
          nome: "Núcleo B",
          tipoAtendimento: "Agendamento Presencial",
          enderecos: [{ bairro: "Madureira", municipio: "Rio de Janeiro" }],
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 2, data: "19/08/2026", hora: "09:00" },
              { idIntervalo: 3, data: "20/08/2026", hora: "09:00" },
            ],
          },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.perguntarTipo, false);
  assert.equal(body.tipoDefault, "presencial");
  assert.equal(body.presencial.temOpcao, true);
  assert.equal(body.presencial.perguntarUnidade, true);
  assert.equal(body.presencial.unidades.length, 2);
  assert.equal(body.presencial.unidades[1].vagas.length, 2);
  assert.deepEqual(body.presencial.vagasUnicaUnidade, []);
});

test("primeiro-atendimento: só remoto, 1 unidade → tipoDefault remoto, unidade+vagas prontas", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 40,
          nome: "Núcleo Remoto Único",
          tipoAtendimento: "Agendamento Remoto",
          vagasDisponiveis: { vagasDisponiveis: [{ idIntervalo: 7, data: "18/08/2026", hora: "08:00" }] },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.perguntarTipo, false);
  assert.equal(body.tipoDefault, "remoto");
  assert.equal(body.remoto.temOpcao, true);
  assert.deepEqual(body.remoto.unidadeEscolhida, { id: 40, nome: "Núcleo Remoto Único" });
  assert.equal(body.remoto.vagas.length, 1);
  assert.equal(body.presencial.temOpcao, false);
});

test("primeiro-atendimento: só remoto, várias unidades → NÃO pergunta unidade, auto-escolhe a de MAIS horários no total (soma entre dias, não nº de dias)", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          // 2 dias, 1 horário cada = 2 no total, mas 2 grupos de data
          id: 40,
          nome: "Remoto Menos Horários",
          tipoAtendimento: "Agendamento Remoto",
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 1, data: "18/08/2026", hora: "08:00" },
              { idIntervalo: 2, data: "19/08/2026", hora: "08:00" },
            ],
          },
        },
        {
          // 1 dia só, 3 horários = 3 no total (mais que a outra, apesar de
          // ter só 1 grupo de data) — confirma que a comparação é por soma
          // de horários, não por quantidade de dias distintos.
          id: 41,
          nome: "Remoto Mais Horários",
          tipoAtendimento: "Agendamento Remoto",
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 3, data: "20/08/2026", hora: "08:00" },
              { idIntervalo: 4, data: "20/08/2026", hora: "09:00" },
              { idIntervalo: 5, data: "20/08/2026", hora: "10:00" },
            ],
          },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.tipoDefault, "remoto");
  assert.equal(body.remoto.unidadeEscolhida.id, 41);
  assert.deepEqual(body.remoto.vagas, [
    {
      data: "20/08/2026",
      horarios: [
        { idIntervalo: 3, hora: "08:00" },
        { idIntervalo: 4, hora: "09:00" },
        { idIntervalo: 5, hora: "10:00" },
      ],
      listaHorarios: "1. 08:00\n2. 09:00\n3. 10:00",
    },
  ]);
  assert.equal(body.remoto.listaDatas, "1. 20/08/2026");
});

test("primeiro-atendimento: presencial E remoto com vaga → PERGUNTA tipo, tipoDefault null, ambos os ramos resolvidos", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 1363,
          nome: "Núcleo Madureira",
          tipoAtendimento: "Agendamento Presencial",
          enderecos: [{ bairro: "Méier", municipio: "Rio de Janeiro" }],
          vagasDisponiveis: {
            vagasDisponiveis: [{ idIntervalo: 677670, data: "18/08/2026", hora: "08:30" }],
          },
        },
        {
          id: 1363,
          nome: "Núcleo Madureira",
          tipoAtendimento: "Agendamento Remoto",
          vagasDisponiveis: {
            vagasDisponiveis: [{ idIntervalo: 677260, data: "19/08/2026", hora: "08:00" }],
          },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.semVagaDisponivel, false);
  assert.equal(body.perguntarTipo, true);
  assert.equal(body.tipoDefault, null);
  assert.equal(body.presencial.temOpcao, true);
  assert.equal(body.presencial.perguntarUnidade, false);
  assert.equal(body.presencial.unidades[0].id, 1363);
  assert.equal(body.remoto.temOpcao, true);
  assert.equal(body.remoto.unidadeEscolhida.id, 1363);
});

test("primeiro-atendimento: mesma unidade presencial e remota (id repetido) — grupos independentes, não se misturam", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 5,
          nome: "Núcleo Dual",
          tipoAtendimento: "Agendamento Presencial",
          vagasDisponiveis: { vagasDisponiveis: [{ idIntervalo: 1, data: "18/08/2026", hora: "08:00" }] },
        },
        {
          id: 5,
          nome: "Núcleo Dual",
          tipoAtendimento: "Agendamento Remoto",
          vagasDisponiveis: { vagasDisponiveis: [{ idIntervalo: 2, data: "18/08/2026", hora: "09:00" }] },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.presencial.unidades.length, 1);
  assert.equal(body.presencial.unidades[0].vagas.length, 1);
  assert.equal(body.remoto.vagas.length, 1);
});

test("primeiro-atendimento: envia complemento na query quando informado", async () => {
  let urlChamada = "";
  mockarFetch((url) => {
    urlChamada = url;
    return Response.json({ dados: [] });
  });
  await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2, complemento: "urbano" });

  assert.match(urlChamada, /idPessoa=1/);
  assert.match(urlChamada, /idAssunto=2/);
  assert.match(urlChamada, /complemento=urbano/);
});

test("primeiro-atendimento: listaDatas com 3 datas reais → 3 linhas, sem linha vazia (bug relatado 2026-08-14 — template do fluxo mostrava '4.'/'5.' em branco quando tinha menos datas que o cap fixo)", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 30,
          nome: "Núcleo Único",
          tipoAtendimento: "Agendamento Presencial",
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 1, data: "18/08/2026", hora: "08:30" },
              { idIntervalo: 2, data: "19/08/2026", hora: "09:00" },
              { idIntervalo: 3, data: "20/08/2026", hora: "11:00" },
            ],
          },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  const linhas = body.presencial.listaDatasUnicaUnidade.split("\n");
  assert.equal(linhas.length, 3);
  assert.deepEqual(linhas, ["1. 18/08/2026", "2. 19/08/2026", "3. 20/08/2026"]);
  assert.ok(
    linhas.every((l: string) => l.trim().length > 0),
    "nenhuma linha vazia"
  );

  const horariosLinhas = body.presencial.unidades[0].vagas[0].listaHorarios.split("\n");
  assert.deepEqual(horariosLinhas, ["1. 08:30"]);
});

test("primeiro-atendimento: 0 datas (unidade sem vaga descartada) → listaDatas com fallback textual, não string vazia nem linha em branco", async () => {
  mockarFetch(() => Response.json({ dados: [] }));
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.presencial.listaDatasUnicaUnidade, "Nenhuma data disponível.");
  assert.equal(body.remoto.listaDatas, "Nenhuma data disponível.");
});

test("primeiro-atendimento: várias unidades presenciais → cada unidade carrega sua própria listaDatas (não só a agregada)", async () => {
  mockarFetch(() =>
    Response.json({
      dados: [
        {
          id: 10,
          nome: "Núcleo A",
          tipoAtendimento: "Agendamento Presencial",
          vagasDisponiveis: { vagasDisponiveis: [{ idIntervalo: 1, data: "18/08/2026", hora: "08:00" }] },
        },
        {
          id: 20,
          nome: "Núcleo B",
          tipoAtendimento: "Agendamento Presencial",
          vagasDisponiveis: {
            vagasDisponiveis: [
              { idIntervalo: 2, data: "19/08/2026", hora: "09:00" },
              { idIntervalo: 3, data: "20/08/2026", hora: "09:00" },
            ],
          },
        },
      ],
    })
  );
  const res = await chamarPrimeiroAtendimento({ idPessoa: 1, idAssunto: 2 });

  const body = res.json();
  assert.equal(body.presencial.unidades[0].listaDatas, "1. 18/08/2026");
  assert.equal(body.presencial.unidades[1].listaDatas, "1. 19/08/2026\n2. 20/08/2026");
});

test("unidade-detalhe: resolve por índice (1-based) contra o JSON de /primeiro-atendimento", async () => {
  const orgaoResultado = JSON.stringify({
    presencial: {
      unidades: [
        {
          id: 10,
          nome: "Núcleo A",
          bairro: "Méier",
          municipio: "Rio de Janeiro",
          vagas: [{ data: "18/08/2026", horarios: [{ idIntervalo: 1, hora: "08:00" }] }],
        },
        {
          id: 20,
          nome: "Núcleo B",
          bairro: "Madureira",
          municipio: "Rio de Janeiro",
          vagas: [{ data: "19/08/2026", horarios: [{ idIntervalo: 2, hora: "09:00" }] }],
        },
      ],
    },
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/unidade-detalhe",
    payload: { unidade_sel: "2", orgao_resultado: orgaoResultado },
  });
  await app.close();

  const body = res.json();
  assert.equal(body.encontrada, true);
  assert.equal(body.id, 20);
  assert.equal(body.nome, "Núcleo B");
  assert.equal(body.vagas.length, 1);
  // orgao_resultado acima é um payload "antigo" (sem listaDatas na unidade,
  // simulando cache de antes desta mudança) — fallback recalcula na hora.
  assert.equal(body.listaDatas, "1. 19/08/2026");
});

test("unidade-detalhe: repassa listaDatas já pronta quando o JSON de origem já veio com o campo (caso normal pós-fix)", async () => {
  const orgaoResultado = JSON.stringify({
    presencial: {
      unidades: [
        {
          id: 10,
          nome: "Núcleo A",
          bairro: "Méier",
          municipio: "Rio de Janeiro",
          vagas: [
            { data: "18/08/2026", horarios: [{ idIntervalo: 1, hora: "08:00" }], listaHorarios: "1. 08:00" },
          ],
          listaDatas: "1. 18/08/2026",
        },
      ],
    },
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/unidade-detalhe",
    payload: { unidade_sel: "1", orgao_resultado: orgaoResultado },
  });
  await app.close();

  assert.equal(res.json().listaDatas, "1. 18/08/2026");
});

test("unidade-detalhe: só resolve por índice — 'id' numérico da unidade que colide com a faixa de índice NÃO é usado como fallback (evita ambiguidade)", async () => {
  const orgaoResultado = JSON.stringify({
    presencial: { unidades: [{ id: 20, nome: "Núcleo B", bairro: null, municipio: null, vagas: [] }] },
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/unidade-detalhe",
    payload: { unidade_sel: "20", orgao_resultado: orgaoResultado }, // não é índice válido (só 1 unidade na lista) nem deve casar por id
  });
  await app.close();

  assert.equal(res.json().encontrada, false);
});

test("unidade-detalhe: seleção fora do range → encontrada false, sem lançar", async () => {
  const orgaoResultado = JSON.stringify({
    presencial: { unidades: [{ id: 10, nome: "A", bairro: null, municipio: null, vagas: [] }] },
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/unidade-detalhe",
    payload: { unidade_sel: "9", orgao_resultado: orgaoResultado },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().encontrada, false);
});

test("unidade-detalhe: orgao_resultado ausente/inválido → encontrada false, sem lançar", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/orgao/unidade-detalhe",
    payload: { unidade_sel: "1" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().encontrada, false);
});
