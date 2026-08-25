import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { montarApp } from "../src/api/app.js";

// Cobre tipoResposta/opcoes em POST /api/tykhe/mensagem (src/api/routes/tykhe/mensagem.ts,
// função tipoEOpcoes) — campos NOVOS e OPCIONAIS que permitem o lado Tykhe
// renderizar um dynamicOptionsNode (botões de verdade) em vez de achatar a
// pergunta em texto puro dentro de `resposta` (que continua igual).
//
// Casos sim_nao e texto são cobertos em test/tykhe-mensagem.test.ts (grafo
// estático, sem Bedrock, sem banco — LGPD é `boolean`, "conte seu caso" é
// texto livre). O caso "opcoes" precisa de um node tipoPergunta:"opcoes" —
// não dá pra alcançar isso no grafo estático sem passar pela triagem
// (Bedrock real), então este arquivo cria um flow MÍNIMO de teste via
// Postgres real (mesmo padrão de test/tykhe-mensagem-flow-id.test.ts: roda
// contra o Postgres de DATABASE_URL, pula inteiro — SEM_BANCO — no modo sem
// banco do CI) e limpa o flow depois.
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";

test(
  "flowId com node tipoPergunta=opcoes → tipoResposta:'opcoes' com a lista exata do node",
  { skip: SEM_BANCO },
  async () => {
    const opcoesParentesco = [
      "Mãe/Pai",
      "Avó/Avô",
      "Irmão/Irmã",
      "Cônjuge/Companheiro(a)",
      "Filho/Filha",
      "Outro",
    ];
    const flow = await prisma!.flow.create({
      data: {
        name: `teste-tipo-resposta-opcoes-${Date.now()}`,
        nodes: [
          {
            id: "p_parentesco",
            type: "pergunta",
            data: {
              texto: "Qual seu parentesco com a pessoa presa?",
              chave: "parentesco",
              tipoPergunta: "opcoes",
              opcoes: opcoesParentesco,
              semReescrita: true,
            },
          },
          { id: "fim", type: "encerrar", data: {} },
        ],
        edges: [{ id: "e1", source: "p_parentesco", target: "fim" }],
      },
    });

    try {
      const app = await montarApp();
      const chatId = `teste-tipo-resposta-opcoes-${Date.now()}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/tykhe/mensagem",
        payload: { chatId, mensagem: "oi", flowId: flow.id },
      });
      await app.close();

      assert.equal(res.statusCode, 200);
      const body = res.json();
      // `resposta` (texto achatado) continua INALTERADA — a pergunta seguida
      // da lista em markdown, exatamente como antes desta mudança (mesmo
      // textoDoConteudo/montarResposta) — só tipoResposta/opcoes são novos.
      assert.match(body.resposta, /^Qual seu parentesco com a pessoa presa\?/);
      assert.match(body.resposta, /- Mãe\/Pai/);
      assert.match(body.resposta, /- Outro$/);
      assert.equal(body.tipoResposta, "opcoes");
      assert.deepEqual(body.opcoes, opcoesParentesco);
    } finally {
      await prisma!.flow.delete({ where: { id: flow.id } }).catch(() => {});
    }
  }
);

after(async () => {
  if (!prisma) return;
  await prisma.$disconnect();
});
