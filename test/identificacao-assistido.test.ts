import { test, after } from "node:test";
import assert from "node:assert/strict";
import { StateGraph, MemorySaver } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { prisma } from "../src/core/db.js";
import { GraphAnnotation, type GraphState } from "../src/core/state.js";
import { roteador } from "../src/core/registro-perguntas.js";
import { dadosPessoais } from "../src/core/nodes/coleta/dados-pessoais.js";
import { dadosResidenciais } from "../src/core/nodes/coleta/dados-residenciais.js";
import { dadosContato } from "../src/core/nodes/coleta/dados-contato.js";
import { familiaPensaoGraph } from "../src/core/services/familia-pensao/graph.js";
import { trabalhistaGraph } from "../src/core/services/trabalhista/graph.js";
import { inssGraph } from "../src/core/services/inss/graph.js";
import { outrosGraph } from "../src/core/services/outros/graph.js";
import {
  identificarAssistido,
  identificarAssistidoLookup,
  identificarAssistidoLookupRoute,
  identificarAssistidoInvalido,
  identificarAssistidoConfirmar,
  identificarAssistidoConfirmarRoute,
  identificarAssistidoUsarCadastro,
  identificarAssistidoOferecerCadastro,
  identificarAssistidoOfertaRoute,
  identificarAssistidoCadastrarPerguntar,
  identificarAssistidoCadastrarCapturar,
  identificarAssistidoCadastrarRoute,
  identificarAssistidoSalvar,
} from "../src/core/nodes/onboarding/identificar-assistido.js";
import {
  verificarCasoAberto,
  verificarCasoAbertoDispatch,
  verificarCasoAbertoAguardar,
  verificarCasoAbertoRoute,
  casoConfirmado,
} from "../src/core/nodes/onboarding/verificar-caso-aberto.js";

// Issue #86 (Coilab #20260133, Fase 1 — sem API externa da DPERJ, só o
// Postgres já existente). Testes de integração REAIS contra o Postgres local
// (mesmo padrão de test/horario-atendimento.test.ts e test/csat.test.ts) —
// db.assistido/db.caso são operações de banco de verdade, não dá pra cobrir
// só com guard estático. A suíte completa também roda com DATABASE_URL=""
// (padrão do CI, ver CLAUDE.md) — nesse modo `prisma` é null e este arquivo
// INTEIRO é pulado (skip, não falha) via SEM_BANCO abaixo.
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";

// Nenhum dos nodes exercitados aqui chama Bedrock (identificar-assistido.ts,
// verificar-caso-aberto.ts, os nodes de coleta e os subgrafos de serviço só
// usam nodePergunta) — diferente de fluxo.test.ts/triagem-confirmacao.test.ts,
// não precisamos de credenciais AWS falsas pra forçar fallback determinístico.

const cpfsCriados: string[] = [];
let seq = 0;
function cpfTeste(): string {
  seq++;
  return `${Date.now()}${seq}`.slice(-11).padStart(11, "0");
}

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

let cfgSeq = 0;
const config = () => ({ configurable: { thread_id: `teste-identificacao-${Date.now()}-${cfgSeq++}` } });

async function responder(graph: ReturnType<typeof construirGrafo>, cfg: object, fala: string) {
  await graph.updateState(cfg, { messages: [new HumanMessage(fala)] });
  return await graph.invoke(null, cfg);
}

// Recorta do grafo estático o trecho relevante à issue: de identificar_assistido
// até caso_confirmado/primeira_mensagem — mesma fiação e mesmo padrão de
// interruptAfter de src/core/graph.ts (ver comentários lá), com um stub no
// lugar de primeira_mensagem/triagem (evita puxar o resto do onboarding, que
// não é o que esta issue cobre) e os subgrafos de serviço/coleta REAIS
// (nenhum usa Bedrock — só nodePergunta) pra provar o roteamento pós
// "é sobre esse caso" e o skip-gate de verdade.
const DESTINOS_ROTEADOR = {
  familia_pensao: "familia_pensao",
  trabalhista: "trabalhista",
  inss: "inss",
  outros: "outros",
  dados_pessoais: "dados_pessoais",
  dados_residenciais: "dados_residenciais",
  dados_contato: "dados_contato",
  enviar_dados: "enviar_dados_stub",
} as const;

function construirGrafo() {
  return new StateGraph(GraphAnnotation)
    .addNode("identificar_assistido", identificarAssistido)
    .addNode("identificar_assistido_lookup", identificarAssistidoLookup)
    .addNode("identificar_assistido_invalido", identificarAssistidoInvalido)
    .addNode("identificar_assistido_confirmar", identificarAssistidoConfirmar)
    .addNode("identificar_assistido_usar_cadastro", identificarAssistidoUsarCadastro)
    .addNode("identificar_assistido_oferecer_cadastro", identificarAssistidoOferecerCadastro)
    .addNode("identificar_assistido_cadastrar", identificarAssistidoCadastrarPerguntar)
    .addNode("identificar_assistido_cadastrar_capturar", identificarAssistidoCadastrarCapturar)
    .addNode("identificar_assistido_salvar", identificarAssistidoSalvar)
    .addNode("verificar_caso_aberto", verificarCasoAberto)
    .addNode("verificar_caso_aberto_aguardar", verificarCasoAbertoAguardar)
    .addNode("caso_confirmado", casoConfirmado)
    .addNode("primeira_mensagem_stub", async (): Promise<Partial<GraphState>> => ({
      messages: [new AIMessage("PRIMEIRA_MENSAGEM_STUB")],
    }))
    .addNode("familia_pensao", familiaPensaoGraph)
    .addNode("trabalhista", trabalhistaGraph)
    .addNode("inss", inssGraph)
    .addNode("outros", outrosGraph)
    .addNode("dados_pessoais", dadosPessoais)
    .addNode("dados_residenciais", dadosResidenciais)
    .addNode("dados_contato", dadosContato)
    .addNode("enviar_dados_stub", async (): Promise<Partial<GraphState>> => ({}))
    .addEdge("__start__", "identificar_assistido")
    .addEdge("identificar_assistido", "identificar_assistido_lookup")
    .addConditionalEdges("identificar_assistido_lookup", identificarAssistidoLookupRoute, {
      encontrado: "identificar_assistido_confirmar",
      novo: "identificar_assistido_oferecer_cadastro",
      invalido: "identificar_assistido_invalido",
    })
    .addEdge("identificar_assistido_invalido", "identificar_assistido_lookup")
    .addConditionalEdges("identificar_assistido_confirmar", identificarAssistidoConfirmarRoute, {
      sim: "identificar_assistido_usar_cadastro",
      nao: "identificar_assistido_cadastrar",
    })
    .addEdge("identificar_assistido_usar_cadastro", "verificar_caso_aberto")
    .addConditionalEdges("identificar_assistido_oferecer_cadastro", identificarAssistidoOfertaRoute, {
      sim: "identificar_assistido_cadastrar",
      nao: "primeira_mensagem_stub",
    })
    .addEdge("identificar_assistido_cadastrar", "identificar_assistido_cadastrar_capturar")
    .addConditionalEdges("identificar_assistido_cadastrar_capturar", identificarAssistidoCadastrarRoute, {
      proxima: "identificar_assistido_cadastrar",
      completo: "identificar_assistido_salvar",
    })
    .addEdge("identificar_assistido_salvar", "verificar_caso_aberto")
    .addConditionalEdges("verificar_caso_aberto", verificarCasoAbertoDispatch, {
      aguardar: "verificar_caso_aberto_aguardar",
      sem_caso: "primeira_mensagem_stub",
    })
    .addConditionalEdges("verificar_caso_aberto_aguardar", verificarCasoAbertoRoute, {
      confirmado: "caso_confirmado",
      outro_assunto: "primeira_mensagem_stub",
    })
    .addConditionalEdges("caso_confirmado", roteador, DESTINOS_ROTEADOR)
    .addEdge("primeira_mensagem_stub", "__end__")
    .addEdge("familia_pensao", "__end__")
    .addEdge("trabalhista", "__end__")
    .addEdge("inss", "__end__")
    .addEdge("outros", "__end__")
    .addEdge("dados_pessoais", "__end__")
    .addEdge("dados_residenciais", "__end__")
    .addEdge("dados_contato", "__end__")
    .addEdge("enviar_dados_stub", "__end__")
    .compile({
      checkpointer: new MemorySaver(),
      interruptAfter: [
        "identificar_assistido",
        "identificar_assistido_invalido",
        "identificar_assistido_confirmar",
        "identificar_assistido_oferecer_cadastro",
        "identificar_assistido_cadastrar",
        "verificar_caso_aberto_aguardar",
      ],
    });
}

after(async () => {
  if (prisma && cpfsCriados.length) {
    await prisma.assistido.deleteMany({ where: { cpf: { in: cpfsCriados } } });
  }
});

// ── Cenário: CPF já cadastrado, sem caso aberto ─────────────────────────────
test(
  "CPF já cadastrado, sem caso aberto: confirma o nome e segue direto (sem repetir endereço/telefone/email)",
  { skip: SEM_BANCO },
  async () => {
    const cpf = cpfTeste();
    cpfsCriados.push(cpf);
    const criado = await prisma!.assistido.create({
      data: {
        cpf,
        nome: "Maria da Silva Teste",
        municipio: "Rio de Janeiro",
        bairro: "Centro",
        logradouro: "Rua Teste",
        numero: "100",
        telefone: "21999990000",
        email: "maria@teste.com",
      },
    });

    const graph = construirGrafo();
    const cfg = config();

    const r1 = await graph.invoke({}, cfg);
    assert.match(textos(r1), /Qual o seu CPF/);

    const r2 = await responder(graph, cfg, cpf);
    assert.match(textos(r2), /Encontrei seu cadastro/);
    assert.match(textos(r2), /Maria da Silva Teste/);

    const r3 = await responder(graph, cfg, "true"); // confirma que é ela mesma
    assert.equal(r3.assistidoId, criado.id);
    assert.equal(r3.dadosColetados.nome, "Maria da Silva Teste");
    assert.equal(r3.dadosColetados.cpf, cpf);
    assert.equal(r3.dadosColetados.cidade, "Rio de Janeiro");
    assert.equal(r3.dadosColetados.bairro, "Centro");
    assert.equal(r3.dadosColetados.rua, "Rua Teste");
    assert.equal(r3.dadosColetados.numero, "100");
    assert.equal(r3.dadosColetados.telefone, "21999990000");
    assert.equal(r3.dadosColetados.email, "maria@teste.com");
    // segue direto pra triagem (aqui, o stub) — sem caso aberto, sem pergunta extra
    assert.match(textos(r3), /PRIMEIRA_MENSAGEM_STUB/);
    assert.doesNotMatch(textos(r3), /Qual o CEP|Em qual cidade|Qual o seu bairro|Qual o nome da sua rua|Qual o número|Qual o seu telefone|Qual o seu e-mail/);
  }
);

// ── Cenário: CPF já cadastrado, com caso em andamento, assistido confirma ──
test(
  "CPF já cadastrado, com caso em andamento, assistido confirma: NÃO repete a pergunta de triagem",
  { skip: SEM_BANCO },
  async () => {
    const cpf = cpfTeste();
    cpfsCriados.push(cpf);
    const criado = await prisma!.assistido.create({ data: { cpf, nome: "João Teste" } });
    await prisma!.caso.create({
      data: {
        assistidoId: criado.id,
        tipo: "Pensão alimentícia",
        identificador: "0001234-56.2026",
        status: "aberto",
      },
    });

    const graph = construirGrafo();
    const cfg = config();

    await graph.invoke({}, cfg);
    await responder(graph, cfg, cpf);
    const r3 = await responder(graph, cfg, "true"); // confirma o nome
    assert.match(textos(r3), /caso em andamento/);
    assert.match(textos(r3), /Pensão alimentícia/);
    assert.match(textos(r3), /0001234-56\.2026/);

    const r4 = await responder(graph, cfg, "true"); // "sim, é sobre esse caso"
    assert.equal(r4.categoria, "familia_pensao", "Caso.tipo 'Pensão alimentícia' deve mapear para a categoria familia_pensao");
    assert.doesNotMatch(textos(r4), /PRIMEIRA_MENSAGEM_STUB/, "não deve cair no fluxo normal de triagem");
    assert.match(textos(r4), /Sobre o que é o seu caso\?/, "deve seguir direto pra próxima pergunta do serviço mapeado");
  }
);

// ── Cenário: CPF novo, cadastro completo ────────────────────────────────────
test(
  "CPF novo, cadastro completo: cria Assistido de verdade no Postgres e dadosColetados reflete os mesmos valores",
  { skip: SEM_BANCO },
  async () => {
    const cpf = cpfTeste();
    cpfsCriados.push(cpf);

    const graph = construirGrafo();
    const cfg = config();

    await graph.invoke({}, cfg);
    const r2 = await responder(graph, cfg, cpf);
    assert.match(textos(r2), /Não encontrei nenhum cadastro/);

    const r3 = await responder(graph, cfg, "true"); // aceita cadastrar
    assert.match(textos(r3), /nome completo/i);

    const r4 = await responder(graph, cfg, "Ana Paula Teste");
    assert.match(textos(r4), /CEP/);
    const r5 = await responder(graph, cfg, "20000-000");
    assert.match(textos(r5), /cidade/i);
    const r6 = await responder(graph, cfg, "Rio de Janeiro");
    assert.match(textos(r6), /bairro/i);
    const r7 = await responder(graph, cfg, "Centro");
    assert.match(textos(r7), /rua/i);
    const r8 = await responder(graph, cfg, "Rua Teste");
    assert.match(textos(r8), /número/i);
    const r9 = await responder(graph, cfg, "50");
    assert.match(textos(r9), /telefone/i);
    const r10 = await responder(graph, cfg, "21988887777");
    assert.match(textos(r10), /e-mail/i);
    const r11 = await responder(graph, cfg, "ana@teste.com"); // cascata completa → salva

    assert.equal(r11.dadosColetados.nome, "Ana Paula Teste");
    assert.equal(r11.dadosColetados.cpf, cpf);
    assert.equal(r11.dadosColetados.cep, "20000-000");
    assert.equal(r11.dadosColetados.cidade, "Rio de Janeiro");
    assert.equal(r11.dadosColetados.bairro, "Centro");
    assert.equal(r11.dadosColetados.rua, "Rua Teste");
    assert.equal(r11.dadosColetados.numero, "50");
    assert.equal(r11.dadosColetados.telefone, "21988887777");
    assert.equal(r11.dadosColetados.email, "ana@teste.com");
    assert.ok(r11.assistidoId, "assistidoId deve estar preenchido após o cadastro");
    assert.match(textos(r11), /PRIMEIRA_MENSAGEM_STUB/);

    const noBanco = await prisma!.assistido.findUnique({ where: { cpf } });
    assert.ok(noBanco, "Assistido deve ter sido criado de verdade no Postgres");
    assert.equal(noBanco?.id, r11.assistidoId);
    assert.equal(noBanco?.nome, "Ana Paula Teste");
    assert.equal(noBanco?.municipio, "Rio de Janeiro");
    assert.equal(noBanco?.bairro, "Centro");
    assert.equal(noBanco?.logradouro, "Rua Teste");
    assert.equal(noBanco?.numero, "50");
    assert.equal(noBanco?.telefone, "21988887777");
    assert.equal(noBanco?.email, "ana@teste.com");
  }
);

// ── Cenário: skip-gate evita repetir pergunta ───────────────────────────────
test(
  "skip-gate: dados_pessoais (coleta tardia) não repete nome/cpf já identificados",
  { skip: SEM_BANCO },
  async () => {
    const cpf = cpfTeste();
    cpfsCriados.push(cpf);
    const criado = await prisma!.assistido.create({
      data: { cpf, nome: "Carlos Teste", telefone: "21977776666", municipio: "Niterói", bairro: "Centro", logradouro: "Rua X", numero: "10" },
    });

    // simula o que identificar_assistido_usar_cadastro faz ao confirmar o nome
    const resultado = await identificarAssistidoUsarCadastro({
      assistidoCandidatoId: criado.id,
      canal: "web",
    } as GraphState);
    assert.equal(resultado.dadosColetados?.nome, "Carlos Teste");
    assert.equal(resultado.dadosColetados?.cpf, cpf);
    // data_nascimento NÃO foi cadastrado no Assistido — não deve ir pra dadosColetados
    assert.equal(resultado.dadosColetados?.data_nascimento, undefined);

    const r = await dadosPessoais({ dadosColetados: resultado.dadosColetados ?? {} } as GraphState);
    assert.doesNotMatch(textos(r), /nome completo/i, "não deve repetir a pergunta de nome");
    assert.doesNotMatch(textos(r), /Qual o seu CPF/, "não deve repetir a pergunta de CPF");
    assert.match(textos(r), /data de nascimento/i, "só a pergunta ainda pendente (data de nascimento) deve aparecer");
  }
);
