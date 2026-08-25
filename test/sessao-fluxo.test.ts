import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { montarApp } from "../src/api/app.js";
import { graph as graphEstatico } from "../src/core/graph.js";

// Cobre a persistência de SessaoFluxo (src/core/chat.ts: resolverFlowId/
// limparSessaoFluxo) — o mecanismo que faz POST /api/tykhe/mensagem lembrar
// qual flowId uma sessão usou na 1ª mensagem e reusar automaticamente nas
// chamadas seguintes, mesmo se o chamador (Tykhe) não reenviar.
//
// BUG que isso corrige (reproduzido ao vivo, 2026-08): a Tykhe só manda o
// campo `flowId` na 1ª chamada de um chatId; chamadas seguintes reconectam
// com só { chatId, mensagem }. Sem persistência, a 2ª chamada resumia o
// checkpoint (estado de um grafo específico, ex: "Pessoa Presa") contra o
// grafo PADRÃO da MariaIA (estruturalmente diferente) — a conversa "reiniciava
// do zero" na prática (saudação/LGPD em vez de continuar a pergunta certa).
//
// Teste de integração REAL contra o Postgres apontado por DATABASE_URL (mesmo
// padrão de test/pessoa-presa.test.ts e test/tykhe-mensagem-flow-id.test.ts)
// — a suíte completa roda com DATABASE_URL="" (CI, ver CLAUDE.md); este
// arquivo INTEIRO é pulado (SEM_BANCO) nesse modo, não falha.
//
// Diferente de tykhe-mensagem-flow-id.test.ts (que usa um flow REAL de
// produção), este arquivo cria seu PRÓPRIO flow mínimo — SessaoFluxo é
// mecanismo interno, não depende de conteúdo real de fluxo (isso é
// responsabilidade do agente `fluxos`), então não faz sentido acoplar este
// teste a dados de produção.
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";

const FLOW_ID_TESTE = "teste-sessao-fluxo-pergunta-unica";
const CHAVE_PERGUNTA = "parentesco_teste_sessao_fluxo";
const TEXTO_PERGUNTA = "Qual seu parentesco com a pessoa presa? (teste sessao-fluxo)";

// Flow de 1 nó só: pergunta de texto livre, semReescrita (sem chamar Bedrock
// — determinístico) e SEM edges de saída — captura a resposta e termina
// (cap_ → END). Estruturalmente diferente de qualquer flow ativo/padrão da
// MariaIA — se uma chamada cair por engano no grafo errado, a captura da
// resposta (CHAVE_PERGUNTA em dadosColetados) simplesmente não acontece.
const FLOW_NODES = [
  {
    id: "pergunta_teste_sessao_fluxo",
    type: "pergunta",
    data: {
      texto: TEXTO_PERGUNTA,
      chave: CHAVE_PERGUNTA,
      tipoPergunta: "texto",
      semReescrita: true,
    },
  },
];

async function garantirFlowTeste() {
  return prisma!.flow.upsert({
    where: { id: FLOW_ID_TESTE },
    update: { nodes: FLOW_NODES, edges: [] },
    create: {
      id: FLOW_ID_TESTE,
      name: "[teste] sessao-fluxo.test.ts (não editar/apagar via painel)",
      nodes: FLOW_NODES,
      edges: [],
      active: false,
    },
  });
}

test(
  "flowId explícito: 1ª mensagem de sessionId novo compila o flow indicado e grava SessaoFluxo",
  { skip: SEM_BANCO },
  async () => {
    await garantirFlowTeste();
    const app = await montarApp();
    const chatId = `teste-sessao-fluxo-a-${Date.now()}`;
    const sessionId = `tykhe:${chatId}`;

    const res = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "oi", flowId: FLOW_ID_TESTE },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(
      res.json().resposta,
      TEXTO_PERGUNTA,
      "1ª mensagem tem que ser a pergunta do flow de teste indicado por flowId"
    );

    const salvo = await prisma!.sessaoFluxo.findUnique({ where: { sessionId } });
    assert.ok(salvo, "SessaoFluxo devia ter sido gravada na 1ª chamada com flowId explícito");
    assert.equal(salvo!.flowId, FLOW_ID_TESTE);
  }
);

test(
  "2ª chamada do MESMO sessionId SEM flowId resolve pro MESMO flow salvo — não cai no grafo padrão",
  { skip: SEM_BANCO },
  async () => {
    await garantirFlowTeste();
    const app = await montarApp();
    const chatId = `teste-sessao-fluxo-b-${Date.now()}`;
    const sessionId = `tykhe:${chatId}`;

    // turno 1: com flowId explícito (comportamento real da Tykhe na 1ª chamada)
    const r1 = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "oi", flowId: FLOW_ID_TESTE },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().resposta, TEXTO_PERGUNTA);

    // turno 2: MESMO chatId, SEM flowId — reconexão real da Tykhe (só reenvia
    // o campo obrigatório na 1ª chamada, não nas seguintes).
    const r2 = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "irmã da pessoa presa" },
    });
    await app.close();

    assert.equal(r2.statusCode, 200);

    // getState funciona com QUALQUER grafo compilado — o checkpointer é o
    // mesmo singleton (ver core/graph.ts) — então dá pra verificar o estado
    // real sem se importar com qual grafo local estamos comparando.
    const st = await graphEstatico.getState({ configurable: { thread_id: sessionId } });
    const coletados = (st.values?.dadosColetados ?? {}) as Record<string, string>;
    assert.equal(
      coletados[CHAVE_PERGUNTA],
      "irmã da pessoa presa",
      "resposta só é capturada se o motor resumiu contra o MESMO flow de teste — se tivesse caído no " +
        "grafo padrão (o bug original), esse campo nunca seria preenchido"
    );

    const salvo = await prisma!.sessaoFluxo.findUnique({ where: { sessionId } });
    assert.equal(salvo?.flowId, FLOW_ID_TESTE, "SessaoFluxo continua apontando pro mesmo flow após a 2ª chamada");
  }
);

test("#sair apaga o registro SessaoFluxo junto com o checkpoint", { skip: SEM_BANCO }, async () => {
  await garantirFlowTeste();
  const app = await montarApp();
  const chatId = `teste-sessao-fluxo-c-${Date.now()}`;
  const sessionId = `tykhe:${chatId}`;

  const r1 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "oi", flowId: FLOW_ID_TESTE },
  });
  assert.equal(r1.statusCode, 200);
  assert.ok(
    await prisma!.sessaoFluxo.findUnique({ where: { sessionId } }),
    "SessaoFluxo devia existir antes do #sair"
  );

  const r2 = await app.inject({
    method: "POST",
    url: "/api/tykhe/mensagem",
    payload: { chatId, mensagem: "#sair" },
  });
  await app.close();

  assert.equal(r2.statusCode, 200);
  const salvo = await prisma!.sessaoFluxo.findUnique({ where: { sessionId } });
  assert.equal(salvo, null, "#sair deve apagar o registro SessaoFluxo junto com o checkpoint");
});

test(
  "conversa encerrada (flow chegou ao fim) limpa SessaoFluxo — próxima mensagem não herda o flowId de uma conversa que já acabou",
  { skip: SEM_BANCO },
  async () => {
    await garantirFlowTeste();
    const app = await montarApp();
    const chatId = `teste-sessao-fluxo-d-${Date.now()}`;
    const sessionId = `tykhe:${chatId}`;

    const r1 = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "oi", flowId: FLOW_ID_TESTE },
    });
    assert.equal(r1.statusCode, 200);

    // responde a única pergunta do flow de teste — sem saídas configuradas,
    // o flow termina (cap_ → END) neste mesmo turno.
    const r2 = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "irmã da pessoa presa" },
    });
    assert.equal(r2.statusCode, 200);
    assert.equal(
      r2.json().status,
      "concluido",
      "flow de teste termina logo após a única pergunta (sem saídas configuradas)"
    );

    // 3ª mensagem: mesma sessão, conversa anterior já ENCERRADA, sem flowId —
    // dispara a limpeza "conversa anterior já encerrou" em processarMensagem().
    const r3 = await app.inject({
      method: "POST",
      url: "/api/tykhe/mensagem",
      payload: { chatId, mensagem: "oi de novo" },
    });
    await app.close();

    assert.equal(r3.statusCode, 200);
    const salvo = await prisma!.sessaoFluxo.findUnique({ where: { sessionId } });
    assert.equal(
      salvo,
      null,
      "conversa reiniciada do zero não deve herdar o flowId de uma conversa anterior que já acabou"
    );
  }
);

after(async () => {
  if (!prisma) return;
  await prisma.flow.deleteMany({ where: { id: FLOW_ID_TESTE } });
  await prisma.$disconnect();
});
