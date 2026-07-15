// Credenciais falsas ANTES de qualquer import — mesmo racional de fluxo.test.ts:
// força fallbacks determinísticos, nunca chama Bedrock/Postgres de verdade.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverTipoPergunta } from "../src/core/chat.js";
import { buildGraphFromFlow, type FlowJSON, type FlowNode } from "../src/core/engine/builder.js";

// Issue #82: resolverTipoPergunta() foi extraída de dentro de
// tipoPerguntaPendente() (refactor puro, ver src/core/chat.ts) pra ser
// reusada por POST /admin/test-chat[/upload] (chat de teste do painel), que
// não tem sessão real (sem Conversation) pra passar por tipoPerguntaPendente()
// inteira — só a resolução chave→tipoPergunta importa ali.

test("flowNodes com pergunta 'documento' casando por data.chave → devolve o tipo do node", () => {
  const flowNodes: FlowNode[] = [
    { id: "p_doc", type: "pergunta", data: { texto: "Envie seu comprovante", chave: "comprovante", tipoPergunta: "documento" } },
  ];
  assert.equal(resolverTipoPergunta("comprovante", flowNodes), "documento");
});

test("flowNodes com pergunta sem data.chave explícita → casa pelo id do node", () => {
  const flowNodes: FlowNode[] = [
    { id: "cpf_assistido", type: "pergunta", data: { texto: "Qual seu CPF?", tipoPergunta: "cpf" } },
  ];
  assert.equal(resolverTipoPergunta("cpf_assistido", flowNodes), "cpf");
});

test("flowNodes com pergunta sem tipoPergunta explícito → default 'texto'", () => {
  const flowNodes: FlowNode[] = [
    { id: "p_nome", type: "pergunta", data: { texto: "Qual seu nome?", chave: "nome" } },
  ];
  assert.equal(resolverTipoPergunta("nome", flowNodes), "texto");
});

test("chave não encontrada em flowNodes (não-null) → cai pro registro estático, não retorna null à toa", () => {
  // "cpf" é uma chave real do registro estático (dados-pessoais.ts, tipo "cpf")
  // — mesmo com flowNodes presente (flow dinâmico), se a chave pendente não
  // é um node de pergunta desse flow, o fallback estático ainda se aplica.
  const flowNodes: FlowNode[] = [
    { id: "outro_node", type: "mensagem", data: { texto: "oi" } },
  ];
  assert.equal(resolverTipoPergunta("cpf", flowNodes), "cpf");
});

test("flowNodes null (grafo estático) → resolve direto pelo registro estático", () => {
  assert.equal(resolverTipoPergunta("cpf", null), "cpf");
});

test("chave desconhecida em ambos (flow e registro estático) → null", () => {
  assert.equal(resolverTipoPergunta("chave-que-nao-existe-em-lugar-nenhum", null), null);
  assert.equal(resolverTipoPergunta("chave-que-nao-existe-em-lugar-nenhum", []), null);
});

// Integração leve: um flow real (buildGraphFromFlow, sem Postgres) pausa numa
// pergunta tipo "documento" — o state.values.ultimaPergunta que o endpoint
// leria bate com o que resolverTipoPergunta resolve contra os nodes do MESMO
// flow (nosExpandidos faz essa expansão em produção; aqui, sem subfluxos, os
// nodes crus já batem 1:1 com o que a expansão produziria).
function flowComDocumento(): FlowJSON {
  return {
    id: "t-resolver-doc",
    nodes: [
      { id: "p_doc", type: "pergunta", data: { texto: "Envie seu comprovante (foto ou PDF).", chave: "comprovante", tipoPergunta: "documento", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [{ id: "e1", source: "p_doc", target: "fim" }],
  };
}

test("pergunta pendente de um flow dinâmico com tipoPergunta documento resolve para 'documento'", async () => {
  const flow = flowComDocumento();
  const graph = buildGraphFromFlow(flow);
  const cfg = { configurable: { thread_id: `teste-resolver-doc-${Date.now()}` } };

  await graph.invoke({}, cfg);
  const estado = await graph.getState(cfg);
  const chavePendente = (estado.values as { ultimaPergunta?: string }).ultimaPergunta;

  assert.equal(chavePendente, "comprovante");
  assert.equal(resolverTipoPergunta(chavePendente!, flow.nodes), "documento");
});
