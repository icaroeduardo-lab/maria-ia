// Credenciais falsas ANTES de qualquer import: dotenv não sobrescreve env já
// setada, então isso força os fallbacks determinísticos (keyword matcher etc.)
// mesmo numa máquina com .env válido — o teste nunca chama Bedrock de verdade.
process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.BEDROCK_KB_ID = "";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { buildGraphFromFlow, type FlowJSON } from "../src/core/engine/builder.js";

// Teste de integração do engine: compila um flow JSON (como o builder visual
// produz) e roda multi-turn de verdade — invoke({}) + updateState/invoke(null)
// (o padrão crítico do CLAUDE.md). Pega regressão de FIAÇÃO do grafo
// (gate/captura/condição/encerramento) que teste unitário não pega.

let seq = 0;
const config = () => ({ configurable: { thread_id: `teste-fluxo-${Date.now()}-${seq++}` } });

// textos das mensagens AI de um resultado
function textos(state: { messages: Array<{ content: unknown }> }): string {
  return state.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ")
    )
    .join(" | ");
}

async function responder(graph: ReturnType<typeof buildGraphFromFlow>, cfg: object, fala: string) {
  await graph.updateState(cfg, { messages: [new HumanMessage(fala)] });
  return await graph.invoke(null, cfg);
}

test("fluxo pergunta → captura → encerrar (multi-turn com interrupt)", async () => {
  const flow: FlowJSON = {
    id: "t1",
    nodes: [
      { id: "boas", type: "mensagem", data: { texto: "Olá!" } },
      { id: "p_nome", type: "pergunta", data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "boas", target: "p_nome" },
      { id: "e2", source: "p_nome", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  // 1º turno: saudação + pergunta, para no interrupt
  const r1 = await graph.invoke({}, cfg);
  assert.match(textos(r1), /Olá!/);
  assert.match(textos(r1), /Qual seu nome\?/);
  assert.equal(r1.dadosColetados.nome, undefined);

  // 2º turno: resume com a resposta → captura + encerramento com protocolo
  const r2 = await responder(graph, cfg, "Maria da Silva");
  assert.equal(r2.dadosColetados.nome, "Maria da Silva");
  assert.ok(r2.protocolo, "encerramento deve gerar protocolo (modo mock)");
});

test("skip-gate: pergunta com chave já preenchida é pulada", async () => {
  const flow: FlowJSON = {
    id: "t2",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "João" } },
      { id: "p_nome", type: "pergunta", data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true } },
      { id: "p_idade", type: "pergunta", data: { texto: "Qual sua idade?", chave: "idade", semReescrita: true } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "seta", target: "p_nome" },
      { id: "e2", source: "p_nome", target: "p_idade" },
      { id: "e3", source: "p_idade", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  // nome já atribuído → gate pula direto pra idade
  const r1 = await graph.invoke({}, cfg);
  assert.doesNotMatch(textos(r1), /Qual seu nome\?/);
  assert.match(textos(r1), /Qual sua idade\?/);
  assert.equal(r1.dadosColetados.nome, "João");
});

test("condicao roteia pelo valor capturado (sim/não)", async () => {
  const flow: FlowJSON = {
    id: "t3",
    nodes: [
      { id: "p_tem", type: "pergunta", data: { texto: "Tem filhos?", chave: "tem_filhos", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "cond", type: "condicao", data: { campo: "tem_filhos" } },
      { id: "m_sim", type: "mensagem", data: { texto: "Ramo COM filhos" } },
      { id: "m_nao", type: "mensagem", data: { texto: "Ramo SEM filhos" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_tem", target: "cond" },
      // convenção do engine: sim_nao normaliza pra "true"/"false" (ids dos botões)
      { id: "e2", source: "cond", target: "m_sim", label: "true" },
      { id: "e3", source: "cond", target: "m_nao", label: "false" },
      { id: "e4", source: "m_sim", target: "fim" },
      { id: "e5", source: "m_nao", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);

  const cfgSim = config();
  await graph.invoke({}, cfgSim);
  const rSim = await responder(graph, cfgSim, "sim");
  assert.match(textos(rSim), /Ramo COM filhos/);
  assert.doesNotMatch(textos(rSim), /Ramo SEM filhos/);

  const cfgNao = config();
  await graph.invoke({}, cfgNao);
  const rNao = await responder(graph, cfgNao, "não tenho");
  assert.match(textos(rNao), /Ramo SEM filhos/);
});

test("classificar cai no matcher por palavra-chave sem Bedrock e roteia o tema", async () => {
  const flow: FlowJSON = {
    id: "t4",
    nodes: [
      { id: "p_relato", type: "pergunta", data: { texto: "Me conta o que houve", chave: "relato", semReescrita: true } },
      { id: "cls", type: "classificar", data: { chave: "categoria", opcoes: ["alimentação", "trabalhista", "outros"] } },
      { id: "m_ali", type: "mensagem", data: { texto: "Tema: pensão alimentícia" } },
      { id: "m_out", type: "mensagem", data: { texto: "Tema: outros" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_relato", target: "cls" },
      { id: "e2", source: "cls", target: "m_ali", label: "alimentação" },
      { id: "e3", source: "cls", target: "m_out", label: "*" },
      { id: "e4", source: "m_ali", target: "fim" },
      { id: "e5", source: "m_out", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  await graph.invoke({}, cfg);
  // credenciais falsas → LLM falha → fallback por palavra-chave ("pensão" → alimentação)
  const r = await responder(graph, cfg, "o pai não paga a pensão do meu filho");
  assert.equal(r.dadosColetados.categoria, "alimentação");
  assert.match(textos(r), /Tema: pensão alimentícia/);
});

test("pergunta sim_nao com saídas rotuladas roteia direto (sem nó condição)", async () => {
  const flow: FlowJSON = {
    id: "t5",
    nodes: [
      { id: "p_aceita", type: "pergunta", data: { texto: "Aceita os termos?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "m_sim", type: "mensagem", data: { texto: "Ramo ACEITOU" } },
      { id: "m_nao", type: "mensagem", data: { texto: "Ramo RECUSOU" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      // labels direto na pergunta — o caso do card #20260113
      { id: "e1", source: "p_aceita", target: "m_sim", label: "true" },
      { id: "e2", source: "p_aceita", target: "m_nao", label: "false" },
      { id: "e3", source: "m_sim", target: "fim" },
      { id: "e4", source: "m_nao", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);

  const cfgSim = config();
  await graph.invoke({}, cfgSim);
  const rSim = await responder(graph, cfgSim, "sim");
  assert.match(textos(rSim), /Ramo ACEITOU/);
  assert.doesNotMatch(textos(rSim), /Ramo RECUSOU/, "fan-out: só um ramo pode executar");

  const cfgNao = config();
  await graph.invoke({}, cfgNao);
  const rNao = await responder(graph, cfgNao, "não");
  assert.match(textos(rNao), /Ramo RECUSOU/);
  assert.doesNotMatch(textos(rNao), /Ramo ACEITOU/);
});

test("skip-gate em pergunta rotulada roteia pela resposta já preenchida", async () => {
  const flow: FlowJSON = {
    id: "t6",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "aceita", valor: "não" } },
      { id: "p_aceita", type: "pergunta", data: { texto: "Aceita?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true } },
      { id: "m_sim", type: "mensagem", data: { texto: "Ramo ACEITOU" } },
      { id: "m_nao", type: "mensagem", data: { texto: "Ramo RECUSOU" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e0", source: "seta", target: "p_aceita" },
      { id: "e1", source: "p_aceita", target: "m_sim", label: "true" },
      { id: "e2", source: "p_aceita", target: "m_nao", label: "false" },
      { id: "e3", source: "m_sim", target: "fim" },
      { id: "e4", source: "m_nao", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();
  // "aceita" já preenchido com "não" → pula a pergunta E cai no ramo certo
  const r = await graph.invoke({}, cfg);
  assert.doesNotMatch(textos(r), /Aceita\?/);
  assert.match(textos(r), /Ramo RECUSOU/);
  assert.doesNotMatch(textos(r), /Ramo ACEITOU/);
});

test("encerrar com texto customizado interpola {{protocolo}} e {{chave}}", async () => {
  const flow: FlowJSON = {
    id: "t-encerrar-texto",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "Maria" } },
      { id: "fim", type: "encerrar", data: { texto: "Obrigada {{nome}}! Protocolo: {{protocolo}}." } },
    ],
    edges: [{ id: "e1", source: "seta", target: "fim" }],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.ok(r.protocolo, "envio mock deve gerar protocolo antes da despedida");
  assert.match(textos(r), new RegExp(`Obrigada Maria! Protocolo: ${r.protocolo}\\.`));
  // não vaza placeholder cru
  assert.doesNotMatch(textos(r), /\{\{/);
});

test("atribuir interpola {{chave}} no valor (copiar/renomear campo)", async () => {
  const flow: FlowJSON = {
    id: "t-atribuir-interpola",
    nodes: [
      { id: "seta1", type: "atribuir", data: { chave: "resultado", valor: '{"a":1}' } },
      { id: "seta2", type: "atribuir", data: { chave: "copia", valor: "{{resultado}}" } },
      { id: "fim", type: "encerrar", data: { texto: "Valor: {{copia}}" } },
    ],
    edges: [
      { id: "e1", source: "seta1", target: "seta2" },
      { id: "e2", source: "seta2", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.equal(r.dadosColetados.copia, '{"a":1}');
  assert.match(textos(r), /Valor: \{"a":1\}/);
});

test("encerrar sem texto mantém a mensagem padrão (regressão)", async () => {
  const flow: FlowJSON = {
    id: "t-encerrar-padrao",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "Maria" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [{ id: "e1", source: "seta", target: "fim" }],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.ok(r.protocolo);
  assert.match(textos(r), /protocolo \*/i); // texto padrão do encerramento cita o protocolo
});

test("subfluxo aninhado (subfluxo dentro de subfluxo) expande e roda até o fim", async () => {
  // top-level → subfluxo "orq" → subfluxo "tema" (2 níveis de aninhamento,
  // ex real: Treino → Orquestrador → Divórcio)
  const top: FlowJSON = {
    id: "t-top",
    nodes: [
      { id: "p_nome", type: "pergunta", data: { texto: "Seu nome?", chave: "nome", semReescrita: true } },
      { id: "sf_orq", type: "subfluxo", data: { refFlowId: "orq" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_nome", target: "sf_orq" },
      { id: "e2", source: "sf_orq", target: "fim" },
    ],
  };
  const orq = {
    nodes: [{ id: "sf_tema", type: "subfluxo" as const, data: { refFlowId: "tema" } }],
    edges: [],
  };
  const tema = {
    nodes: [
      { id: "p_detalhe", type: "pergunta" as const, data: { texto: "Qual detalhe?", chave: "detalhe", semReescrita: true } },
      { id: "m_confirma", type: "mensagem" as const, data: { texto: "Detalhe: {{detalhe}}" } },
    ],
    edges: [{ id: "e1", source: "p_detalhe", target: "m_confirma" }],
  };

  const graph = buildGraphFromFlow(top, { orq, tema });
  const cfg = config();

  const r1 = await graph.invoke({}, cfg);
  assert.match(textos(r1), /Seu nome\?/);

  const r2 = await responder(graph, cfg, "Maria");
  assert.match(textos(r2), /Qual detalhe\?/, "deve alcançar a pergunta DENTRO do subfluxo aninhado (2º nível)");

  const r3 = await responder(graph, cfg, "urgente");
  assert.equal(r3.dadosColetados.detalhe, "urgente");
  assert.match(textos(r3), /Detalhe: urgente/);
  assert.ok(r3.protocolo, "deve sair do aninhamento e chegar no encerrar do flow top-level");
});

// ── nó api genérico (Coilab #20260115): rota erro, corpo seletivo, secrets ────

import { createServer, type Server } from "node:http";

async function servidorDeTeste(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; srv: Server; corpos: unknown[] }> {
  const corpos: unknown[] = [];
  const srv = createServer((req, res) => {
    let bruto = "";
    req.on("data", (c) => (bruto += c));
    req.on("end", () => {
      corpos.push({ body: bruto ? JSON.parse(bruto) : null, headers: req.headers });
      handler!(req, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const porta = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${porta}`, srv, corpos };
}

test("api externa: corpo só com camposCorpo, header com {{secret:X}}, sem _sessao", async () => {
  process.env.CHAVE_TESTE_API = "segredo-123";
  const { url, srv, corpos } = await servidorDeTeste((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const flow: FlowJSON = {
      id: "t-api-seletivo",
      nodes: [
        { id: "s1", type: "atribuir", data: { chave: "cep", valor: "20000-000" } },
        { id: "s2", type: "atribuir", data: { chave: "cpf", valor: "111.222.333-44" } },
        {
          id: "chamada", type: "api",
          data: { url: `${url}/consulta`, chave: "resultado", camposCorpo: ["cep"], headers: { "x-api-key": "{{secret:CHAVE_TESTE_API}}" } },
        },
        { id: "fim", type: "encerrar", data: {} },
      ],
      edges: [
        { id: "e0", source: "s1", target: "s2" },
        { id: "e1", source: "s2", target: "chamada" },
        { id: "e2", source: "chamada", target: "fim" },
      ],
    };
    const graph = buildGraphFromFlow(flow);
    const r = await graph.invoke({}, config());
    const recebido = corpos[0] as { body: Record<string, unknown>; headers: Record<string, string> };
    assert.deepEqual(recebido.body, { cep: "20000-000" }); // cpf NÃO vaza; _sessao/_canal não vão pra fora
    assert.equal(recebido.headers["x-api-key"], "segredo-123");
    assert.equal(r.dadosColetados.resultado_erro, "false");
    assert.match(String(r.dadosColetados.resultado), /"ok":true/);
  } finally {
    srv.close();
    delete process.env.CHAVE_TESTE_API;
  }
});

test("api com edge 'erro': status 500 roteia pro ramo de falha sem gravar o corpo", async () => {
  const { url, srv } = await servidorDeTeste((_req, res) => {
    res.writeHead(500);
    res.end("explodiu");
  });
  try {
    const flow: FlowJSON = {
      id: "t-api-erro",
      nodes: [
        { id: "chamada", type: "api", data: { url: `${url}/x`, chave: "resultado", camposCorpo: [] } },
        { id: "m_ok", type: "mensagem", data: { texto: "Deu certo" } },
        { id: "m_erro", type: "mensagem", data: { texto: "Tivemos um problema" } },
        { id: "fim", type: "encerrar", data: {} },
      ],
      edges: [
        { id: "e1", source: "chamada", target: "m_ok" },
        { id: "e2", source: "chamada", target: "m_erro", label: "erro" },
        { id: "e3", source: "m_ok", target: "fim" },
        { id: "e4", source: "m_erro", target: "fim" },
      ],
    };
    const graph = buildGraphFromFlow(flow);
    const r = await graph.invoke({}, config());
    assert.match(textos(r), /Tivemos um problema/);
    assert.doesNotMatch(textos(r), /Deu certo/);
    assert.equal(r.dadosColetados.resultado, undefined); // corpo do 500 não vira resultado
    assert.equal(r.dadosColetados.resultado_erro, "true");
  } finally {
    srv.close();
  }
});

test("api com edge 'erro': sucesso segue o caminho feliz", async () => {
  const { url, srv } = await servidorDeTeste((_req, res) => {
    res.writeHead(200);
    res.end("{}");
  });
  try {
    const flow: FlowJSON = {
      id: "t-api-feliz",
      nodes: [
        { id: "chamada", type: "api", data: { url: `${url}/x`, chave: "resultado", camposCorpo: [] } },
        { id: "m_ok", type: "mensagem", data: { texto: "Deu certo" } },
        { id: "m_erro", type: "mensagem", data: { texto: "Tivemos um problema" } },
        { id: "fim", type: "encerrar", data: {} },
      ],
      edges: [
        { id: "e1", source: "chamada", target: "m_ok" },
        { id: "e2", source: "chamada", target: "m_erro", label: "erro" },
        { id: "e3", source: "m_ok", target: "fim" },
        { id: "e4", source: "m_erro", target: "fim" },
      ],
    };
    const graph = buildGraphFromFlow(flow);
    const r = await graph.invoke({}, config());
    assert.match(textos(r), /Deu certo/);
    assert.doesNotMatch(textos(r), /Tivemos um problema/);
  } finally {
    srv.close();
  }
});

test("api sem edge 'erro' mantém comportamento atual em falha (segue sem o dado)", async () => {
  const flow: FlowJSON = {
    id: "t-api-regressao",
    nodes: [
      // porta 1 fecha a conexão na hora — falha rápida e determinística
      { id: "chamada", type: "api", data: { url: "http://127.0.0.1:1/x", chave: "resultado" } },
      { id: "m_seguiu", type: "mensagem", data: { texto: "Seguiu o fluxo" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "chamada", target: "m_seguiu" },
      { id: "e2", source: "m_seguiu", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.match(textos(r), /Seguiu o fluxo/);
  assert.equal(r.dadosColetados.resultado, undefined);
});
