import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { montarApp } from "../src/api/app.js";

// Rotas "API fake" do subfluxo Pessoa Presa (ver src/api/routes/pessoa-presa.ts).
// Testes de integração REAIS contra o Postgres local (mesmo padrão de
// test/horario-atendimento.test.ts). A suíte completa também roda com
// DATABASE_URL="" (padrão do CI, ver CLAUDE.md) — nesse modo `prisma` é null
// e este arquivo INTEIRO é pulado (skip, não falha) via SEM_BANCO abaixo.
// O guard 503-sem-banco fica em test/pessoa-presa-sem-banco.test.ts (arquivo
// próprio, porque o valor de DATABASE_URL é fixado na primeira importação de
// src/core/db.ts no processo — não dá pra alternar com/sem banco no mesmo arquivo).
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";
const db = prisma;

// RGs/ids de teste com prefixo "9" pra não colidir com os do prisma/seed.ts.
const RG_ATIVO_COM_ORGAO = "91111111111";
const RG_ATIVO_SEM_ORGAO = "92222222222";
const RG_LIBERTADO_SEM_CASO = "93333333333";
const RG_LIBERTADO_COM_CASO = "94444444444";
const NUMERO_PROCESSO = "99988877766";

async function garantirFixtures() {
  const ativoComOrgao = await db!.pessoaPresa.upsert({
    where: { rg: RG_ATIVO_COM_ORGAO },
    update: {},
    create: {
      rg: RG_ATIVO_COM_ORGAO,
      nome: "Teste Ativo Com Orgao",
      situacao: "ATIVO",
      tipoPreso: "CONDENADO",
      regime: "fechado",
      idPessoa: "TESTE-PES-0001",
      idSeap: "TESTE-SEAP-0001",
      orgaoPreso: { nome: "Defensoria Teste", telefone: "2100000001", endereco: "Rua Teste, 1" },
    },
  });
  await db!.pessoaPresa.upsert({
    where: { rg: RG_ATIVO_SEM_ORGAO },
    update: {},
    create: {
      rg: RG_ATIVO_SEM_ORGAO,
      nome: "Teste Ativo Sem Orgao",
      situacao: "ATIVO",
      tipoPreso: "PROVISORIO",
      idPessoa: "TESTE-PES-0002",
      idSeap: "TESTE-SEAP-0002",
    },
  });
  const libertadoSemCaso = await db!.pessoaPresa.upsert({
    where: { rg: RG_LIBERTADO_SEM_CASO },
    update: {},
    create: {
      rg: RG_LIBERTADO_SEM_CASO,
      nome: "Teste Libertado Sem Caso",
      situacao: "LIBERTADO",
      tipoPreso: "SENTENCIADO",
      idPessoa: "TESTE-PES-0003",
      idSeap: "TESTE-SEAP-0003",
      orgaoLiberto: { nome: "Defensoria Egressos Teste", telefone: "2100000003", endereco: "Rua Teste, 3" },
    },
  });
  const libertadoComCaso = await db!.pessoaPresa.upsert({
    where: { rg: RG_LIBERTADO_COM_CASO },
    update: {},
    create: {
      rg: RG_LIBERTADO_COM_CASO,
      nome: "Teste Libertado Com Caso",
      situacao: "LIBERTADO",
      tipoPreso: "SENTENCIADO",
      idPessoa: "TESTE-PES-0004",
      idSeap: "TESTE-SEAP-0004",
    },
  });
  if ((await db!.casoPessoaPresa.count({ where: { pessoaPresaId: libertadoComCaso.id } })) === 0) {
    await db!.casoPessoaPresa.create({
      data: { pessoaPresaId: libertadoComCaso.id, identificador: "TESTE-CASO-0001", tipo: "Execução penal", status: "ABERTO" },
    });
  }
  await db!.processoPessoaPresa.upsert({
    where: { numero: NUMERO_PROCESSO },
    update: {},
    create: { numero: NUMERO_PROCESSO, origem: "SEEU", idProcesso: "TESTE-PROC-0001" },
  });
  return { ativoComOrgao, libertadoSemCaso, libertadoComCaso };
}

test("GET /api/pessoa-presa/consultar-rg — RG encontrado retorna dados FLAT (situacao/nome/idPessoa/idSeap)", { skip: SEM_BANCO }, async () => {
  const { ativoComOrgao } = await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: `/api/pessoa-presa/consultar-rg?rg=${RG_ATIVO_COM_ORGAO}` });
  await app.close();

  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.encontrado, true);
  assert.equal(corpo.situacao, "ATIVO");
  assert.equal(corpo.nome, "Teste Ativo Com Orgao");
  assert.equal(corpo.tipoPreso, "CONDENADO");
  assert.equal(corpo.regime, "fechado");
  assert.equal(corpo.idPessoa, ativoComOrgao.idPessoa);
  assert.equal(corpo.idSeap, ativoComOrgao.idSeap);
});

test("GET /api/pessoa-presa/consultar-rg — RG não cadastrado retorna encontrado:false, situacao nao_encontrado", { skip: SEM_BANCO }, async () => {
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/pessoa-presa/consultar-rg?rg=00099988877" });
  await app.close();

  assert.equal(res.statusCode, 200);
  const corpo = res.json();
  assert.equal(corpo.encontrado, false);
  assert.equal(corpo.situacao, "nao_encontrado");
  assert.equal(corpo.nome, "");
});

test("GET /api/pessoa-presa/consultar-rg — sem query rg → encontrado:false, não quebra", { skip: SEM_BANCO }, async () => {
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/pessoa-presa/consultar-rg" });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().encontrado, false);
});

test("GET /api/pessoa-presa/consultar-processo — número encontrado retorna origem + idProcesso", { skip: SEM_BANCO }, async () => {
  await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: `/api/pessoa-presa/consultar-processo?numero=${NUMERO_PROCESSO}` });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.encontrado, true);
  assert.equal(corpo.origem, "SEEU");
  assert.equal(corpo.idProcesso, "TESTE-PROC-0001");
});

test("GET /api/pessoa-presa/consultar-processo — número não encontrado retorna encontrado:false", { skip: SEM_BANCO }, async () => {
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/pessoa-presa/consultar-processo?numero=00000000000" });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.encontrado, false);
  assert.equal(corpo.origem, "");
});

test("GET /api/pessoa-presa/casos — idPessoaPresa com caso aberto retorna status ABERTO (literal comparado pelo condicao)", { skip: SEM_BANCO }, async () => {
  const { libertadoComCaso } = await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: `/api/pessoa-presa/casos?idPessoaPresa=${libertadoComCaso.idPessoa}` });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.tem_casos, true);
  assert.equal(corpo.status, "ABERTO");
  assert.equal(corpo.casos.length, 1);
  assert.equal(corpo.casos[0].identificador, "TESTE-CASO-0001");
});

test("GET /api/pessoa-presa/casos — idPessoaPresa sem caso aberto retorna status vazio (cai no braço * do condicao)", { skip: SEM_BANCO }, async () => {
  const { libertadoSemCaso } = await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: `/api/pessoa-presa/casos?idPessoaPresa=${libertadoSemCaso.idPessoa}` });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.tem_casos, false);
  assert.equal(corpo.status, "");
});

test("GET /api/pessoa-presa/orgao-responsavel — idSeap com órgão vinculado retorna status encontrado", { skip: SEM_BANCO }, async () => {
  const { ativoComOrgao } = await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: `/api/pessoa-presa/orgao-responsavel?idSeap=${ativoComOrgao.idSeap}` });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.status, "encontrado");
  assert.equal(corpo.orgao.nome, "Defensoria Teste");
});

test("GET /api/pessoa-presa/orgao-responsavel — idSeap sem órgão vinculado retorna status nao_encontrado", { skip: SEM_BANCO }, async () => {
  await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/api/pessoa-presa/orgao-responsavel?idSeap=TESTE-SEAP-0002" });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.status, "nao_encontrado");
  assert.equal(corpo.orgao, null);
});

test("GET /api/pessoa-presa/orgao-responsavel-liberto — idSeap com órgão (réu liberto) retorna status encontrado", { skip: SEM_BANCO }, async () => {
  const { libertadoSemCaso } = await garantirFixtures();
  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: `/api/pessoa-presa/orgao-responsavel-liberto?idSeap=${libertadoSemCaso.idSeap}` });
  await app.close();

  const corpo = res.json();
  assert.equal(corpo.status, "encontrado");
  assert.equal(corpo.orgao.nome, "Defensoria Egressos Teste");
});

after(async () => {
  if (!db) return; // modo sem banco: nada foi tocado, nada a limpar
  await db.$disconnect();
});
