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
      {
        id: "p_nome",
        type: "pergunta",
        data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true },
      },
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
  assert.deepEqual(
    r1.trilhaExecutada,
    ["boas", "p_nome"],
    "trilha (issue #93) acumula ids do flow em ordem, sem os auxiliares gate_/cap_"
  );

  // 2º turno: resume com a resposta → captura + encerramento com protocolo
  const r2 = await responder(graph, cfg, "Maria da Silva");
  assert.equal(r2.dadosColetados.nome, "Maria da Silva");
  assert.ok(r2.protocolo, "encerramento deve gerar protocolo (modo mock)");
  assert.deepEqual(
    r2.trilhaExecutada,
    ["boas", "p_nome", "fim"],
    "trilha cresce a cada turno, acumulando sobre o checkpoint"
  );
});

test("skip-gate: pergunta com chave já preenchida é pulada", async () => {
  const flow: FlowJSON = {
    id: "t2",
    nodes: [
      { id: "seta", type: "atribuir", data: { chave: "nome", valor: "João" } },
      {
        id: "p_nome",
        type: "pergunta",
        data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true },
      },
      {
        id: "p_idade",
        type: "pergunta",
        data: { texto: "Qual sua idade?", chave: "idade", semReescrita: true },
      },
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
  assert.deepEqual(
    r1.trilhaExecutada,
    ["seta", "p_idade"],
    "p_nome pulado pelo gate não entra na trilha (issue #93)"
  );
});

test("dadosIniciais (issue #134): seed de dadosColetados na 1ª invoke pula a pergunta (skip-gate)", async () => {
  // reproduz exatamente o que POST /admin/test-chat faz na 1ª chamada da
  // sessão: invoke({ canal, dadosColetados: dadosIniciais }, cfg) — sem isso,
  // testar um subfluxo isolado (ex: Primeiro Atendimento) trava na pergunta
  // de uma chave que só existiria vinda de um nó anterior do fluxo pai.
  const flow: FlowJSON = {
    id: "t-dados-iniciais",
    nodes: [
      {
        id: "p_idPessoa",
        type: "pergunta",
        data: { texto: "Qual o id da pessoa?", chave: "idPessoa", semReescrita: true },
      },
      {
        id: "p_relato",
        type: "pergunta",
        data: { texto: "Me conta o que houve?", chave: "relato", semReescrita: true },
      },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_idPessoa", target: "p_relato" },
      { id: "e2", source: "p_relato", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  // idPessoa já vem seedado (como se um nó anterior do fluxo pai já tivesse
  // preenchido) → gate pula direto pra relato, sem re-perguntar
  const r1 = await graph.invoke({ canal: "web", dadosColetados: { idPessoa: "abc-123" } }, cfg);
  assert.doesNotMatch(
    textos(r1),
    /Qual o id da pessoa\?/,
    "pergunta com chave já preenchida via dadosIniciais deve ser pulada"
  );
  assert.match(textos(r1), /Me conta o que houve\?/, "próxima pergunta pendente segue normal");
  assert.equal(r1.dadosColetados.idPessoa, "abc-123", "valor seedado permanece em dadosColetados");
  assert.deepEqual(r1.trilhaExecutada, ["p_relato"], "p_idPessoa pulado pelo gate não entra na trilha");
});

test("nova sessão (thread_id novo) começa com trilha vazia — reiniciar zera a trajetória", async () => {
  const flow: FlowJSON = {
    id: "t2b",
    nodes: [
      {
        id: "p_nome",
        type: "pergunta",
        data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true },
      },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [{ id: "e1", source: "p_nome", target: "fim" }],
  };
  const graph = buildGraphFromFlow(flow);

  const cfgA = config();
  await graph.invoke({}, cfgA);
  const rA = await responder(graph, cfgA, "Ana");
  assert.deepEqual(rA.trilhaExecutada, ["p_nome", "fim"]);

  // thread_id diferente (equivalente a novo sessionId em /admin/test-chat) →
  // checkpoint novo, sem histórico da sessão anterior
  const cfgB = config();
  const rB = await graph.invoke({}, cfgB);
  assert.deepEqual(rB.trilhaExecutada, ["p_nome"], "sessão nova não herda a trilha de outra thread");
});

test("condicao roteia pelo valor capturado (sim/não)", async () => {
  const flow: FlowJSON = {
    id: "t3",
    nodes: [
      {
        id: "p_tem",
        type: "pergunta",
        data: { texto: "Tem filhos?", chave: "tem_filhos", tipoPergunta: "sim_nao", semReescrita: true },
      },
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
      {
        id: "p_relato",
        type: "pergunta",
        data: { texto: "Me conta o que houve", chave: "relato", semReescrita: true },
      },
      {
        id: "cls",
        type: "classificar",
        data: { chave: "categoria", opcoes: ["alimentação", "trabalhista", "outros"] },
      },
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

test("classificar isolado via dadosIniciais (sem HumanMessage) ainda classifica pelo relato seedado — issue #143/card #20260199", async () => {
  // reproduz exatamente o bug: testar um subfluxo isolado via POST
  // /admin/test-chat com dadosIniciais:{relato:"..."} nunca gera uma
  // HumanMessage no thread (só a 1ª invoke acontece, com dadosColetados
  // pré-seedado) — antes do fix, ultimaFalaUsuario() voltava "" e
  // classificarTexto() batia o guard "sem relato → catch-all" ANTES de
  // sequer tentar o LLM, então o classificar caía sempre em "outros"
  // mesmo com um relato claro em dadosColetados.
  const flow: FlowJSON = {
    id: "t-classificar-dados-iniciais",
    nodes: [
      {
        id: "cls",
        type: "classificar",
        data: { chave: "categoria", opcoes: ["alimentação", "trabalhista", "outros"] },
      },
      { id: "m_ali", type: "mensagem", data: { texto: "Tema: pensão alimentícia" } },
      { id: "m_out", type: "mensagem", data: { texto: "Tema: outros" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "cls", target: "m_ali", label: "alimentação" },
      { id: "e2", source: "cls", target: "m_out", label: "*" },
      { id: "e3", source: "m_ali", target: "fim" },
      { id: "e4", source: "m_out", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  // mesma chamada que /admin/test-chat faz na 1ª invoke com dadosIniciais —
  // NUNCA passa por updateState/HumanMessage nesse turno.
  const r = await graph.invoke(
    { canal: "web", dadosColetados: { relato: "o pai não paga a pensão do meu filho" } },
    cfg
  );
  // credenciais falsas → LLM falha → fallback por palavra-chave ("pensão" → alimentação);
  // o que importa aqui é que o fallback FOI ACIONADO (relato não ficou vazio) em vez
  // de cair direto no categoriaPadrao ("outros") por falta de HumanMessage.
  assert.equal(r.dadosColetados.categoria, "alimentação");
  assert.match(textos(r), /Tema: pensão alimentícia/);
});

test("pergunta sim_nao com saídas rotuladas roteia direto (sem nó condição)", async () => {
  const flow: FlowJSON = {
    id: "t5",
    nodes: [
      {
        id: "p_aceita",
        type: "pergunta",
        data: { texto: "Aceita os termos?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true },
      },
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
      {
        id: "p_aceita",
        type: "pergunta",
        data: { texto: "Aceita?", chave: "aceita", tipoPergunta: "sim_nao", semReescrita: true },
      },
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

test("transferir_humano pausa o grafo e sinaliza handoff (card #20260117)", async () => {
  const flow: FlowJSON = {
    id: "t-handoff",
    nodes: [
      {
        id: "p1",
        type: "pergunta",
        data: { texto: "Qual seu problema?", chave: "problema", semReescrita: true },
      },
      { id: "th", type: "transferir_humano", data: { texto: "Transferindo pra um atendente!" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p1", target: "th" },
      { id: "e2", source: "th", target: "fim" },
    ],
  };
  const graph = buildGraphFromFlow(flow);
  const cfg = config();

  const r1 = await graph.invoke({}, cfg);
  assert.match(textos(r1), /Qual seu problema\?/);

  const r2 = await responder(graph, cfg, "não sei resolver sozinho");
  assert.match(textos(r2), /Transferindo pra um atendente!/);
  assert.equal(r2.handoff, "aguardando");
  // pausou ANTES do encerrar — não gerou protocolo nem terminou o grafo
  assert.equal(r2.protocolo, "");
  const state = await graph.getState(cfg);
  assert.ok((state.next?.length ?? 0) > 0, "deve ficar pausado (next não-vazio), não terminar");
});

test("transferir_humano sem texto usa mensagem padrão", async () => {
  const flow: FlowJSON = {
    id: "t-handoff-padrao",
    nodes: [{ id: "th", type: "transferir_humano", data: {} }],
    edges: [],
  };
  const graph = buildGraphFromFlow(flow);
  const r = await graph.invoke({}, config());
  assert.match(textos(r), /atendente humano/i);
  assert.equal(r.handoff, "aguardando");
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
      {
        id: "p_detalhe",
        type: "pergunta" as const,
        data: { texto: "Qual detalhe?", chave: "detalhe", semReescrita: true },
      },
      { id: "m_confirma", type: "mensagem" as const, data: { texto: "Detalhe: {{detalhe}}" } },
    ],
    edges: [{ id: "e1", source: "p_detalhe", target: "m_confirma" }],
  };

  const graph = buildGraphFromFlow(top, { orq, tema });
  const cfg = config();

  const r1 = await graph.invoke({}, cfg);
  assert.match(textos(r1), /Seu nome\?/);
  assert.deepEqual(r1.trilhaExecutada, ["p_nome"]);

  const r2 = await responder(graph, cfg, "Maria");
  assert.match(
    textos(r2),
    /Qual detalhe\?/,
    "deve alcançar a pergunta DENTRO do subfluxo aninhado (2º nível)"
  );
  // trilha (issue #93) atravessa o subfluxo naturalmente: o node de pergunta
  // expandido entra com seu id prefixado (sf_<subfluxoNode>_...), igual ao
  // que ultimaPergunta/dadosColetados já usam — front resolve contra o
  // canvas do sub-flow "tema" usando esse mesmo id
  assert.equal(r2.trilhaExecutada.length, 2);
  assert.equal(r2.trilhaExecutada[0], "p_nome");
  assert.match(
    r2.trilhaExecutada[1],
    /^sf_.*_p_detalhe$/,
    "id do node de pergunta do sub-flow aninhado, prefixado"
  );

  const r3 = await responder(graph, cfg, "urgente");
  assert.equal(r3.dadosColetados.detalhe, "urgente");
  assert.match(textos(r3), /Detalhe: urgente/);
  assert.ok(r3.protocolo, "deve sair do aninhamento e chegar no encerrar do flow top-level");
  assert.equal(
    r3.trilhaExecutada.length,
    4,
    "p_nome, pergunta e mensagem do sub-flow aninhado, encerrar do top-level"
  );
  assert.equal(r3.trilhaExecutada[0], "p_nome");
  assert.equal(r3.trilhaExecutada[3], "fim");
  assert.match(
    r3.trilhaExecutada[2],
    /^sf_.*_m_confirma$/,
    "id do node de mensagem do sub-flow aninhado, prefixado"
  );
});

test("transferir_humano terminal DENTRO de subfluxo continua dead-end (não religa pro pai)", async () => {
  // bug real (achado ao vivo testando "Cadastro de Assistido" →
  // cad_transfere_doc_falha via /admin/test-chat): expandirSubfluxos religava
  // TODO terminal sem data.saida — inclusive transferir_humano — pra saída
  // do subfluxo no pai, ignorando que handoff sem edge própria é dead-end
  // intencional (mesmo comportamento de transferir_humano no nível-topo).
  // O sub-flow abaixo tem os dois terminais lado a lado (mesmo pergunta
  // sim_nao decide o ramo) pra provar que só o transferir_humano trava;
  // o terminal "mensagem" comum continua fluindo pro pai normalmente.
  const top: FlowJSON = {
    id: "t-top-handoff-sub",
    nodes: [
      { id: "p_nome", type: "pergunta", data: { texto: "Seu nome?", chave: "nome", semReescrita: true } },
      { id: "sf", type: "subfluxo", data: { refFlowId: "sub" } },
      { id: "fim", type: "encerrar", data: {} },
    ],
    edges: [
      { id: "e1", source: "p_nome", target: "sf" },
      { id: "e2", source: "sf", target: "fim" },
    ],
  };
  const sub = {
    nodes: [
      {
        id: "p_falha",
        type: "pergunta" as const,
        data: { texto: "Falhou o documento?", chave: "falha", tipoPergunta: "sim_nao", semReescrita: true },
      },
      { id: "th", type: "transferir_humano" as const, data: { texto: "Transferindo pra um atendente!" } },
      { id: "m_ok", type: "mensagem" as const, data: { texto: "Documento certinho!" } },
    ],
    edges: [
      { id: "e1", source: "p_falha", target: "th", label: "true" },
      { id: "e2", source: "p_falha", target: "m_ok", label: "false" },
    ],
  };

  // ramo transferir_humano: deve travar de verdade dentro do subfluxo
  const graphHandoff = buildGraphFromFlow(top, { sub });
  const cfgHandoff = config();
  const r1 = await graphHandoff.invoke({}, cfgHandoff);
  assert.match(textos(r1), /Seu nome\?/);

  const r2 = await responder(graphHandoff, cfgHandoff, "Maria");
  assert.match(textos(r2), /Falhou o documento\?/);

  const r3 = await responder(graphHandoff, cfgHandoff, "sim");
  assert.match(textos(r3), /Transferindo pra um atendente!/);
  assert.equal(r3.handoff, "aguardando");
  assert.equal(r3.protocolo, "", "não deve ter religado pro encerrar do pai e gerado protocolo");
  assert.ok(!r3.trilhaExecutada.includes("fim"), "não deve ter alcançado o encerrar do fluxo pai");
  // dead-end de verdade (sem edge de saída pro "th") termina em END depois
  // de rodar — igual ao comportamento comprovado a nível-topo (nenhuma
  // pergunta/nó pendente sobra em `next`, ver teste
  // "transferir_humano sem texto usa mensagem padrão"). O que prova que o
  // handoff NÃO foi religado artificialmente pro fluxo pai é a trilha nunca
  // alcançar "fim" nem gerar protocolo, mesmo mandando mais mensagens depois.
  const stateHandoff = await graphHandoff.getState(cfgHandoff);
  assert.deepEqual(
    stateHandoff.next ?? [],
    [],
    "dead-end real: sem pergunta/nó do fluxo PAI pendente em next, igual ao topo"
  );

  // mandar mais uma mensagem depois do handoff NÃO deve avançar a trilha pro
  // fluxo pai (processarMensagem() de verdade bloqueia antes mesmo de chamar
  // o grafo, checando handoffStatus na Conversation — ver src/core/chat.ts;
  // no nível do grafo puro, o equivalente é: sem edge de saída de "th",
  // resumir não tem pra onde ir além do END já alcançado, então a trilha e o
  // protocolo continuam exatamente como estavam no handoff)
  const r4 = await responder(graphHandoff, cfgHandoff, "mais uma mensagem qualquer");
  assert.equal(r4.protocolo, "", "continua sem protocolo — não avançou pro encerrar do pai");
  assert.ok(!r4.trilhaExecutada.includes("fim"), "trilha ainda não deve ter alcançado o encerrar do pai");
  assert.deepEqual(
    r4.trilhaExecutada,
    r3.trilhaExecutada,
    "trilha não cresce mais — o dead-end não reabre nem religa pro pai"
  );

  // ramo mensagem comum: deve continuar fluindo pro pai normalmente (não quebrar esse caso)
  const graphFluxo = buildGraphFromFlow(top, { sub });
  const cfgFluxo = config();
  await graphFluxo.invoke({}, cfgFluxo);
  await responder(graphFluxo, cfgFluxo, "Maria");
  const rFinal = await responder(graphFluxo, cfgFluxo, "não");
  assert.match(textos(rFinal), /Documento certinho!/);
  assert.ok(rFinal.protocolo, "terminal mensagem comum deve religar pro pai e chegar no encerrar");
  assert.ok(rFinal.trilhaExecutada.includes("fim"), "trilha deve alcançar o encerrar do fluxo pai");
});

// ── nó api genérico (Coilab #20260115): rota erro, corpo seletivo, secrets ────

import { createServer, type Server } from "node:http";

async function servidorDeTeste(
  handler: Parameters<typeof createServer>[1]
): Promise<{ url: string; srv: Server; corpos: unknown[] }> {
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
          id: "chamada",
          type: "api",
          data: {
            url: `${url}/consulta`,
            chave: "resultado",
            camposCorpo: ["cep"],
            headers: { "x-api-key": "{{secret:CHAVE_TESTE_API}}" },
          },
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

test("api interna injeta _sessao/_canal mesmo quando NÃO é o node imediatamente resumido após interrupt (issue #166)", async () => {
  // reproduz o bug real: node "api" alcançado por edge DENTRO do mesmo tick
  // de invoke(null, cfg) — depois do node de captura de uma pergunta, não
  // como o próprio node resumido. Antes do fix em builder.ts (wrapper de
  // addNode não repassava `config` pra criarNode()), _sessao chegava
  // undefined nesse cenário e o JSON.stringify removia a chave do corpo.
  const { url, srv, corpos } = await servidorDeTeste((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const selfUrlOriginal = process.env.SELF_URL;
  process.env.SELF_URL = url;
  try {
    const flow: FlowJSON = {
      id: "t-api-sessao-nao-imediato",
      nodes: [
        {
          id: "p1",
          type: "pergunta",
          data: { texto: "Qual seu nome?", chave: "nome", semReescrita: true },
        },
        { id: "chamada", type: "api", data: { url: "/interno/echo", chave: "resultado" } },
        { id: "fim", type: "encerrar", data: {} },
      ],
      edges: [
        { id: "e1", source: "p1", target: "chamada" },
        { id: "e2", source: "chamada", target: "fim" },
      ],
    };
    const graph = buildGraphFromFlow(flow);
    const cfg = config();

    // 1º turno: pausa no interrupt da pergunta — node "api" ainda não rodou
    await graph.invoke({}, cfg);
    assert.equal(corpos.length, 0, "api não deve rodar antes do resume");

    // resume: cap_p1 → chamada (api) → fim, tudo no MESMO invoke(null, cfg) —
    // "chamada" é alcançado por edge, não é o node resumido diretamente
    const r = await responder(graph, cfg, "Maria da Silva");
    assert.equal(corpos.length, 1, "api deve rodar dentro do mesmo tick do resume");
    const recebido = corpos[0] as { body: Record<string, unknown> };
    assert.equal(
      recebido.body._sessao,
      cfg.configurable.thread_id,
      "_sessao deve chegar preenchido mesmo como node não-imediato do resume"
    );
    assert.equal(recebido.body._canal, "web");
    assert.equal(r.dadosColetados.resultado_erro, "false");
  } finally {
    srv.close();
    if (selfUrlOriginal === undefined) delete process.env.SELF_URL;
    else process.env.SELF_URL = selfUrlOriginal;
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
