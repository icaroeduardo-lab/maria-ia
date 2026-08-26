// VERDE_JWT_TOKEN/VERDE_CLIENT_ID NÃO setados (ficam "") ANTES de qualquer
// import: gatewayVerdeGet/Post (src/core/verde-direto.ts) devolvem
// null/not-ok direto sem token/client id configurados — sem isso o default
// de VERDE_API_URL é o endpoint real de homologação (env.ts) e o teste
// faria fetch de verdade. Precisamos que a consulta ao Verde "erre" pra
// exercitar exatamente o fallback local que este arquivo testa (issue #138
// — card Coilab #20260195).
process.env.VERDE_JWT_TOKEN = "";
process.env.VERDE_CLIENT_ID = "";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { montarApp } from "../src/api/app.js";

// POST /api/elegibilidade/verificar (ver src/api/routes/elegibilidade.ts).
// A suíte completa também roda com DATABASE_URL="" (padrão do CI, ver
// CLAUDE.md) — nesse modo `prisma` é null e este arquivo INTEIRO é pulado
// (skip, não falha) via SEM_BANCO, mesmo padrão de test/pessoa-presa.test.ts.
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";
const db = prisma;

// CPFs de teste com prefixo "9" pra não colidir com seed/dados reais.
const CPF_LOCAL_RJ = "91234567890";
const CPF_LOCAL_SP = "98765432100";
// DDD de São Paulo (fora do RJ) — força a checagem a passar pelo Verde/local
// em vez de resolver de cara pelo DDD do telefone.
const TELEFONE_SP = "5511999990000";

async function garantirFixtures() {
  await db!.assistido.upsert({
    where: { cpf: CPF_LOCAL_RJ },
    update: { uf: "rj" }, // minúsculo de propósito — cobre o .toUpperCase()
    create: { cpf: CPF_LOCAL_RJ, nome: "Teste Local RJ", uf: "rj" },
  });
  await db!.assistido.upsert({
    where: { cpf: CPF_LOCAL_SP },
    update: { uf: "SP" },
    create: { cpf: CPF_LOCAL_SP, nome: "Teste Local SP", uf: "SP" },
  });
}

test(
  "CPF só existe local com uf RJ → decisao ok, sem cair no fallback 'perguntar' (issue #138)",
  { skip: SEM_BANCO },
  async () => {
    await garantirFixtures();
    const app = await montarApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/elegibilidade/verificar",
      payload: { telefone_whatsapp: TELEFONE_SP, cpf: CPF_LOCAL_RJ },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().decisao, "ok");
  },
);

test(
  "CPF só existe local com uf diferente de RJ, sem caso no Verde → ainda cai em 'perguntar'",
  { skip: SEM_BANCO },
  async () => {
    await garantirFixtures();
    const app = await montarApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/elegibilidade/verificar",
      payload: { telefone_whatsapp: TELEFONE_SP, cpf: CPF_LOCAL_SP },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().decisao, "perguntar");
  },
);

test(
  "CPF sem cadastro nenhum (Verde nem local) → cai em 'perguntar' (regressão do comportamento anterior)",
  { skip: SEM_BANCO },
  async () => {
    const app = await montarApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/elegibilidade/verificar",
      payload: { telefone_whatsapp: TELEFONE_SP, cpf: "90000000000" },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().decisao, "perguntar");
  },
);

// POST /api/elegibilidade/tem-caso-aberto (card Coilab #20260197) — endpoint
// enxuto pro novo desenho do gate (roda depois da ficha, sem DDD/UF). Não
// depende de banco: VERDE_JWT_TOKEN/VERDE_CLIENT_ID vazios (setado no topo
// do arquivo) já garante consultarCasosVerde() determinístico (Verde "fora
// do ar" → null).
test("tem-caso-aberto: cpf inválido (tamanho errado) não chama o Verde, devolve tem_caso false", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/elegibilidade/tem-caso-aberto",
    payload: { cpf: "123" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tem_caso, false);
});

test("tem-caso-aberto: cpf válido sem resposta do Verde (credencial vazia) → tem_caso false, sem lançar", async () => {
  const app = await montarApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/elegibilidade/tem-caso-aberto",
    payload: { cpf: "90000000000" },
  });
  await app.close();

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tem_caso, false);
});

after(async () => {
  if (!db) return; // modo sem banco: nada foi tocado, nada a limpar
  await db.$disconnect();
});
