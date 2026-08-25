import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { montarApp } from "../src/api/app.js";
import { graph as graphEstatico } from "../src/core/graph.js";

// Cobre o parâmetro flowId de POST /api/tykhe/mensagem (src/api/routes/tykhe/mensagem.ts)
// — pular o MariaIA inteiro e começar DIRETO num fluxo específico. Caso real:
// "Pessoa Presa" — a Tykhe já fez saudação/LGPD/CPF do lado dela e a pessoa
// já escolheu a categoria num menu, não faz sentido reclassificar via relato.
//
// Teste de integração REAL contra o Postgres apontado por DATABASE_URL (mesmo
// padrão de test/pessoa-presa.test.ts e test/horario-atendimento.test.ts) — a
// suíte completa roda com DATABASE_URL="" (CI, ver CLAUDE.md); este arquivo
// INTEIRO é pulado (SEM_BANCO) nesse modo, não falha.
//
// Usa o id REAL do flow de produção "Pessoa Presa (protótipo IA)" (conferido
// ao vivo via mcp-maria-flows contra o ALB de produção, 2026-08-25: 1º nó é
// pp_parentesco, sem edge de entrada, texto exato "Qual seu parentesco com a
// pessoa presa?"). flowId é sobre ONDE o motor entra — não sobre conteúdo de
// fluxo (isso é responsabilidade do agente `fluxos`); por isso não fabricamos
// um flow de teste à parte. Se o Postgres apontado por DATABASE_URL não tiver
// esse flow específico (ex: banco local sem os dados de produção), o teste
// pula individualmente (SEM_FLOW) em vez de falhar por engano.
const FLOW_ID_PESSOA_PRESA = "cmrnz07ti007blc0j5givi327";
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";

test(
  "flowId=Pessoa Presa + dadosConhecidos: 1ª mensagem de um chatId novo pula o MariaIA e devolve a 1ª pergunta do fluxo (pp_parentesco)",
  { skip: SEM_BANCO },
  async (t) => {
    const flow = await prisma!.flow.findUnique({ where: { id: FLOW_ID_PESSOA_PRESA } });
    if (!flow) {
      t.skip(`flow ${FLOW_ID_PESSOA_PRESA} (Pessoa Presa) não encontrado neste banco — requer dados de produção`);
      return;
    }

    const app = await montarApp();
    const chatId = `teste-tykhe-flowid-pp-${Date.now()}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: {
        chatId,
        mensagem: "quero ajuda pra uma pessoa presa",
        flowId: FLOW_ID_PESSOA_PRESA,
        dadosConhecidos: { cpf: "11122233344", idPessoa: 4242, nome: "Maria da Silva", email: "maria@example.com" },
      },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(
      body.resposta,
      "Qual seu parentesco com a pessoa presa?",
      "1ª mensagem tem que ser a 1ª pergunta do fluxo Pessoa Presa — NÃO a saudação da Maria nem pergunta de CPF"
    );
    assert.doesNotMatch(
      body.resposta,
      /aceita os termos|Me conte um pouco sobre o seu caso/,
      "não pode ter passado pela saudação/LGPD/relato do MariaIA — flowId pula o fluxo inteiro"
    );
    assert.equal(body.status, "em_andamento");

    // dadosConhecidos combina com flowId: os dois se aplicam juntos na 1ª
    // mensagem de um chatId novo — flowId escolhe onde começar, dadosConhecidos
    // semeia resultado_cpf/cpf em dadosColetados (mesma leitura de estado que
    // os testes de dadosConhecidos em tykhe-mensagem.test.ts já fazem; getState
    // funciona com QUALQUER grafo compilado porque o checkpointer é o mesmo
    // singleton, ver core/graph.ts).
    const st = await graphEstatico.getState({ configurable: { thread_id: `tykhe:${chatId}` } });
    const coletados = (st.values?.dadosColetados ?? {}) as Record<string, string>;
    assert.equal(coletados.cpf, "11122233344", "cpf flat semeado junto com o flowId");
    const resultadoCpf = JSON.parse(coletados.resultado_cpf ?? "null");
    assert.equal(resultadoCpf.dados.idPessoa, 4242);
    assert.equal(resultadoCpf.dados.nome, "Maria da Silva");
  }
);

// Regressão "sem flowId" com o texto EXATO do grafo estático (saudação +
// LGPD) já é coberta em test/tykhe-mensagem.test.ts, que força
// DATABASE_URL="" (prisma null → obterGraph() sempre usa graphEstatico,
// nunca um flow ativo real). Este arquivo roda contra Postgres de verdade —
// aqui o comportamento "sem flowId" correto é usar o flow ATIVO do banco
// (obterGraph() sem flowId, já era assim antes desta mudança), não
// necessariamente o grafo estático. O que importa verificar aqui é que
// omitir flowId NUNCA cai por engano no fluxo Pessoa Presa (flowId é opt-in,
// não "gruda" entre chamadas/rotas).
test(
  "sem flowId: NUNCA roda o fluxo Pessoa Presa por engano (flowId é opt-in)",
  { skip: SEM_BANCO },
  async () => {
    const app = await montarApp();
    const chatId = `teste-tykhe-sem-flowid-${Date.now()}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "oi" },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.notEqual(
      body.resposta,
      "Qual seu parentesco com a pessoa presa?",
      "sem flowId no body, jamais deveria cair no fluxo Pessoa Presa"
    );
    assert.equal(body.status, "em_andamento");
  }
);

after(async () => {
  if (!prisma) return;
  await prisma.$disconnect();
});
