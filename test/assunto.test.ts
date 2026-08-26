// VERDE_API_URL fake + mock de global.fetch: cobre src/api/routes/assunto.ts
// (navegação da árvore de assunto, resolução de escolha por índice e
// metadados) — nunca testado antes. Sem banco (assunto.ts não usa prisma).
// VERDE_JWT_TOKEN/VERDE_CLIENT_ID fake também obrigatórios — sem eles
// gatewayVerdeGet/Post (verde-direto.ts) devolve null/not-ok sem nem tentar
// a rede (mesmo padrão de base vazia do client antigo).
process.env.VERDE_API_URL = "http://fake-gateway.test";
process.env.VERDE_JWT_TOKEN = "fake-token";
process.env.VERDE_CLIENT_ID = "fake-client";

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { montarApp } from "../src/api/app.js";

function mockarFetch(handler: (url: string) => Response) {
  return mock.method(globalThis, "fetch", async (input: string | URL) => handler(String(input)));
}

afterEach(() => {
  mock.reset();
});

test("consultar-item-arvore: sem idCategoria/idItemCategoria → assunto_encontrado false, sem chamar o gateway", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/consultar-item-arvore",
    payload: {},
  });
  await app.close();

  assert.equal(res.json().assunto_encontrado, false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("consultar-item-arvore: 1ª chamada usa idCategoria, folha da árvore já encontrada → idAssunto mapeado", async () => {
  let urlChamada = "";
  mockarFetch((url) => {
    urlChamada = url;
    return Response.json({
      dados: { assuntoEncontrado: true, idAssunto: 3151, nomeAssunto: "Divórcio Consensual" },
    });
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/consultar-item-arvore",
    payload: { idCategoria: 7 },
  });
  await app.close();

  assert.match(urlChamada, /idCategoria=7/);
  const body = res.json();
  assert.equal(body.assunto_encontrado, true);
  assert.equal(body.idAssunto, 3151);
});

test("consultar-item-arvore: idItemCategoria (chamada seguinte) tem prioridade sobre idCategoria e devolve lista de respostas", async () => {
  let urlChamada = "";
  mockarFetch((url) => {
    urlChamada = url;
    return Response.json({
      dados: {
        assuntoEncontrado: false,
        pergunta: "Qual o motivo?",
        respostas: [
          { id: 101, resposta: "Consensual" },
          { id: 102, resposta: "Litigioso" },
        ],
      },
    });
  });
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/consultar-item-arvore",
    payload: { idCategoria: 7, idItemCategoria: 55 },
  });
  await app.close();

  assert.match(urlChamada, /idItemCategoria=55/);
  assert.doesNotMatch(urlChamada, /idCategoria=7/);
  const body = res.json();
  assert.equal(body.assunto_encontrado, false);
  assert.equal(body.pergunta, "Qual o motivo?");
  assert.equal(body.respostas.length, 2);
  assert.equal(body.lista, "1. Consensual\n2. Litigioso");
});

test("consultar-item-arvore: gateway fora do ar → 502 gateway_verde_indisponivel (ativa edge de erro do node api)", async () => {
  mockarFetch(() => new Response(null, { status: 500 }));
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/consultar-item-arvore",
    payload: { idCategoria: 7 },
  });
  await app.close();

  assert.equal(res.statusCode, 502);
  assert.equal(res.json().erro, "gateway_verde_indisponivel");
});

test("resolver-escolha: resolve por índice numérico da lista anterior", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/resolver-escolha",
    payload: {
      escolha_sel: "2",
      resultado_arvore: JSON.stringify({
        respostas: [
          { id: 101, resposta: "Consensual" },
          { id: 102, resposta: "Litigioso" },
        ],
      }),
    },
  });
  await app.close();

  assert.deepEqual(res.json(), { encontrada: true, idItemCategoria: 102 });
});

test("resolver-escolha: resolve pelo texto completo da opção", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/resolver-escolha",
    payload: {
      escolha_sel: "Litigioso",
      resultado_arvore: JSON.stringify({ respostas: [{ id: 102, resposta: "Litigioso" }] }),
    },
  });
  await app.close();

  assert.equal(res.json().idItemCategoria, 102);
});

test("resolver-escolha: escolha não encontrada → encontrada false", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/resolver-escolha",
    payload: { escolha_sel: "Inexistente", resultado_arvore: JSON.stringify({ respostas: [] }) },
  });
  await app.close();

  assert.deepEqual(res.json(), { encontrada: false, idItemCategoria: null });
});

test("metadados: idAssunto inválido → encontrado false, sem chamar o gateway", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/assunto/metadados" });
  await app.close();

  assert.equal(res.json().encontrado, false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("metadados: idAssunto conhecido → urgente e documentos_necessarios mapeados", async () => {
  mockarFetch(() =>
    Response.json({
      dados: { urgente: true, txDocumentosNecessarios: "RG, CPF, comprovante de residência" },
    })
  );
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/assunto/metadados?idAssunto=3151" });
  await app.close();

  assert.deepEqual(res.json(), {
    encontrado: true,
    urgente: true,
    documentos_necessarios: "RG, CPF, comprovante de residência",
    nomeMateria: null,
    descricao: null,
  });
});

test("metadados: gateway não encontra o assunto → encontrado false", async () => {
  mockarFetch(() => new Response(null, { status: 404 }));
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/assunto/metadados?idAssunto=999999" });
  await app.close();

  assert.equal(res.json().encontrado, false);
});

test("metadados: idAssunto do tipo ORIENTAÇÃO (item-folha informativo, ex: 3281) → nomeMateria e descricao mapeados", async () => {
  mockarFetch(() =>
    Response.json({
      dados: {
        nomeMateria: "ORIENTAÇÃO",
        descricao:
          "SE JÁ EXISTE UM PROCESSO SOBRE ESSE ASSUNTO, REFAÇA A BUSCA... INFORME O NÚMERO DO PROCESSO...",
        urgente: false,
      },
    })
  );
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/assunto/metadados?idAssunto=3281" });
  await app.close();

  assert.deepEqual(res.json(), {
    encontrado: true,
    urgente: false,
    documentos_necessarios: null,
    nomeMateria: "ORIENTAÇÃO",
    descricao:
      "SE JÁ EXISTE UM PROCESSO SOBRE ESSE ASSUNTO, REFAÇA A BUSCA... INFORME O NÚMERO DO PROCESSO...",
  });
});

test("documentos: idAssunto inválido → encontrado false, fallback, sem chamar o gateway", async () => {
  const fetchMock = mockarFetch(() => {
    throw new Error("não deveria chamar o gateway");
  });
  const app = await montarApp();
  const res = await app.inject({ method: "POST", url: "/api/assunto/documentos", payload: {} });
  await app.close();

  assert.deepEqual(res.json(), {
    encontrado: false,
    listaDocumentos: "Nenhum documento específico informado — leve RG e CPF.",
  });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("documentos: idAssunto 3151 → lista numerada distinguindo obrigatório de condicional", async () => {
  mockarFetch(() =>
    Response.json({
      dados: {
        documentosNecessarios: [
          { id: 133, nomeDocumento: "Certidão de Nascimento ou Casamento", basico: true },
          { id: 136, nomeDocumento: "Última declaração de Imposto de Renda", basico: true },
          { id: 140, nomeDocumento: "Certidão de nascimento da criança ou adolescente", basico: false },
        ],
      },
    })
  );
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/documentos",
    payload: { idAssunto: 3151 },
  });
  await app.close();

  assert.deepEqual(res.json(), {
    encontrado: true,
    listaDocumentos:
      "- Certidão de Nascimento ou Casamento (obrigatório)\n" +
      "- Última declaração de Imposto de Renda (obrigatório)\n" +
      "- Certidão de nascimento da criança ou adolescente (se aplicável)",
  });
});

test("documentos: assunto encontrado mas sem documentosNecessarios → fallback", async () => {
  mockarFetch(() => Response.json({ dados: { nome: "Assunto sem documentos" } }));
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/documentos",
    payload: { idAssunto: 4242 },
  });
  await app.close();

  assert.deepEqual(res.json(), {
    encontrado: true,
    listaDocumentos: "Nenhum documento específico informado — leve RG e CPF.",
  });
});

test("documentos: gateway fora do ar → encontrado false, fallback (sem 502 — não é o node que decide erro de fluxo aqui)", async () => {
  mockarFetch(() => new Response(null, { status: 500 }));
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/assunto/documentos",
    payload: { idAssunto: 3151 },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    encontrado: false,
    listaDocumentos: "Nenhum documento específico informado — leve RG e CPF.",
  });
});
