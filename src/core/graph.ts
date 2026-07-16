import "dotenv/config";
import { mkdirSync } from "node:fs";
import { StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { GraphAnnotation } from "./state.js";
import { saudacao } from "./nodes/onboarding/saudacao.js";
import { lgpd, lgpdProcessar, lgpdRecusado, lgpdRoute } from "./nodes/onboarding/lgpd.js";
import { primeiraMensagem } from "./nodes/onboarding/primeira-mensagem.js";
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
} from "./nodes/onboarding/identificar-assistido.js";
import {
  verificarCasoAberto,
  verificarCasoAbertoDispatch,
  verificarCasoAbertoAguardar,
  verificarCasoAbertoRoute,
  casoConfirmado,
} from "./nodes/onboarding/verificar-caso-aberto.js";
import {
  triagem,
  triagemConfirmar,
  triagemConfirmarRoute,
  triagemEscolher,
  triagemCapturarEscolha,
} from "./nodes/atendimento/triagem.js";
import { informativo } from "./nodes/atendimento/informativo.js";
import { extrator } from "./nodes/atendimento/extrator.js";
import { enviarDados } from "./nodes/atendimento/enviar-dados.js";
import { encerramento } from "./nodes/atendimento/encerramento.js";
import { dadosPessoais } from "./nodes/coleta/dados-pessoais.js";
import { dadosResidenciais } from "./nodes/coleta/dados-residenciais.js";
import { dadosContato } from "./nodes/coleta/dados-contato.js";
import { familiaPensaoGraph } from "./services/familia-pensao/graph.js";
import { trabalhistaGraph } from "./services/trabalhista/graph.js";
import { inssGraph } from "./services/inss/graph.js";
import { outrosGraph } from "./services/outros/graph.js";
import { roteador } from "./registro-perguntas.js";
import { env } from "./env.js";

// Postgres quando DATABASE_URL configurada (Fase 5); SQLite como fallback de dev
async function criarCheckpointer(): Promise<BaseCheckpointSaver> {
  const dbUrl = env.databaseUrl();
  if (dbUrl) {
    // node-pg verifica o cert com sslmode=require; em RDS/gerenciado usamos
    // no-verify (SSL sem validar a CA). schema separado das migrações do Prisma.
    const url = dbUrl.replace(/sslmode=require/i, "sslmode=no-verify");
    const saver = PostgresSaver.fromConnString(url, { schema: "langgraph" });
    await saver.setup();
    return saver;
  }
  mkdirSync("./data", { recursive: true }); // garante o diretório do SQLite (CI/máquina nova)
  return SqliteSaver.fromConnString("./data/checkpoints.db");
}
export const checkpointer = await criarCheckpointer();

// Destinos possíveis do roteador (próxima pergunta pendente ou envio à DPERJ)
const DESTINOS_ROTEADOR = {
  familia_pensao:     "familia_pensao",
  trabalhista:        "trabalhista",
  inss:               "inss",
  outros:             "outros",
  dados_pessoais:     "dados_pessoais",
  dados_residenciais: "dados_residenciais",
  dados_contato:      "dados_contato",
  enviar_dados:       "enviar_dados",
} as const;

export const graph = new StateGraph(GraphAnnotation)

  // ── Nodes ──────────────────────────────────────────────────────────────
  .addNode("saudacao",           saudacao)
  .addNode("lgpd",               lgpd)
  .addNode("lgpd_processar",     lgpdProcessar)
  .addNode("lgpd_recusado",      lgpdRecusado)
  .addNode("identificar_assistido",              identificarAssistido)
  .addNode("identificar_assistido_lookup",       identificarAssistidoLookup)
  .addNode("identificar_assistido_invalido",     identificarAssistidoInvalido)
  .addNode("identificar_assistido_confirmar",    identificarAssistidoConfirmar)
  .addNode("identificar_assistido_usar_cadastro", identificarAssistidoUsarCadastro)
  .addNode("identificar_assistido_oferecer_cadastro", identificarAssistidoOferecerCadastro)
  .addNode("identificar_assistido_cadastrar",    identificarAssistidoCadastrarPerguntar)
  .addNode("identificar_assistido_cadastrar_capturar", identificarAssistidoCadastrarCapturar)
  .addNode("identificar_assistido_salvar",       identificarAssistidoSalvar)
  .addNode("verificar_caso_aberto",          verificarCasoAberto)
  .addNode("verificar_caso_aberto_aguardar", verificarCasoAbertoAguardar)
  .addNode("caso_confirmado",                casoConfirmado)
  .addNode("primeira_mensagem",  primeiraMensagem)
  .addNode("triagem",            triagem)
  .addNode("triagem_confirmar",       triagemConfirmar)
  .addNode("triagem_escolher",        triagemEscolher)
  .addNode("triagem_capturar_escolha", triagemCapturarEscolha)
  .addNode("extrator_inicial",   extrator)
  .addNode("informativo",        informativo)
  .addNode("extrator",           extrator)
  .addNode("familia_pensao",     familiaPensaoGraph)
  .addNode("trabalhista",        trabalhistaGraph)
  .addNode("inss",               inssGraph)
  .addNode("outros",             outrosGraph)
  .addNode("dados_pessoais",     dadosPessoais)
  .addNode("dados_residenciais", dadosResidenciais)
  .addNode("dados_contato",      dadosContato)
  .addNode("enviar_dados",       enviarDados)
  .addNode("encerramento",       encerramento)

  // ── Entrada ────────────────────────────────────────────────────────────
  .addEdge("__start__", "saudacao")

  // ── Boas-vindas + LGPD ─────────────────────────────────────────────────
  .addEdge("saudacao", "lgpd")
  // interruptAfter["lgpd"] pausa aqui — aguarda resposta do usuário
  .addEdge("lgpd", "lgpd_processar")
  .addConditionalEdges("lgpd_processar", lgpdRoute, {
    // lgpdRoute continua devolvendo a chave "primeira_mensagem" (não mudou);
    // só o destino real muda — identificação do assistido entra ANTES da
    // primeira mensagem sobre o caso (issue #86).
    primeira_mensagem: "identificar_assistido",
    lgpd_recusado:     "lgpd_recusado",
  })
  .addEdge("lgpd_recusado", "encerramento")

  // ── Identificação do assistido (Assistido/Caso reais — issue #86) ───────
  // interruptAfter["identificar_assistido"] pausa aqui — aguarda o CPF
  .addEdge("identificar_assistido", "identificar_assistido_lookup")
  .addConditionalEdges("identificar_assistido_lookup", identificarAssistidoLookupRoute, {
    encontrado: "identificar_assistido_confirmar",
    novo:       "identificar_assistido_oferecer_cadastro",
    invalido:   "identificar_assistido_invalido",
  })
  // interruptAfter["identificar_assistido_invalido"] pausa aqui — pede o CPF de novo
  .addEdge("identificar_assistido_invalido", "identificar_assistido_lookup")

  // interruptAfter["identificar_assistido_confirmar"] pausa aqui — aguarda sim/não
  .addConditionalEdges("identificar_assistido_confirmar", identificarAssistidoConfirmarRoute, {
    sim: "identificar_assistido_usar_cadastro",
    nao: "identificar_assistido_cadastrar", // nome não bateu: recadastra (update)
  })
  .addEdge("identificar_assistido_usar_cadastro", "verificar_caso_aberto")

  // interruptAfter["identificar_assistido_oferecer_cadastro"] pausa aqui — aguarda sim/não
  .addConditionalEdges("identificar_assistido_oferecer_cadastro", identificarAssistidoOfertaRoute, {
    sim: "identificar_assistido_cadastrar",
    // "não" (recusa cadastro): segue sem vincular Assistido — dadosColetados
    // fica vazio e os nodes de coleta tardios perguntam tudo normalmente.
    nao: "primeira_mensagem",
  })

  // Cascata de cadastro (nome + endereço + telefone + email) — loop próprio,
  // não passa pelo extrator/roteador compartilhados (ver comentário no arquivo).
  // interruptAfter["identificar_assistido_cadastrar"] pausa aqui — aguarda a resposta
  .addEdge("identificar_assistido_cadastrar", "identificar_assistido_cadastrar_capturar")
  .addConditionalEdges("identificar_assistido_cadastrar_capturar", identificarAssistidoCadastrarRoute, {
    proxima:  "identificar_assistido_cadastrar",
    completo: "identificar_assistido_salvar",
  })
  .addEdge("identificar_assistido_salvar", "verificar_caso_aberto")

  // Caso em aberto: verificarCasoAberto decide (sem pausar) se há pergunta a
  // fazer; só interrompe no node-âncora "aguardar" quando há caso de fato.
  .addConditionalEdges("verificar_caso_aberto", verificarCasoAbertoDispatch, {
    aguardar: "verificar_caso_aberto_aguardar",
    sem_caso: "primeira_mensagem",
  })
  // interruptAfter["verificar_caso_aberto_aguardar"] pausa aqui — aguarda sim/não
  .addConditionalEdges("verificar_caso_aberto_aguardar", verificarCasoAbertoRoute, {
    confirmado:    "caso_confirmado",
    outro_assunto: "primeira_mensagem",
  })
  // "sim, é sobre esse caso": não repete a triagem — vai direto pra próxima
  // pergunta pendente do serviço mapeado a partir de Caso.tipo.
  .addConditionalEdges("caso_confirmado", roteador, DESTINOS_ROTEADOR)

  // ── Triagem + confirmação + extração inicial do contexto ────────────────
  // interruptAfter["primeira_mensagem"] pausa aqui — aguarda descrição do caso
  .addEdge("primeira_mensagem", "triagem")
  .addEdge("triagem", "triagem_confirmar")
  // interruptAfter["triagem_confirmar"] pausa aqui — aguarda sim/não
  .addConditionalEdges("triagem_confirmar", triagemConfirmarRoute, {
    confirmado: "extrator_inicial",
    corrigir:   "triagem_escolher",
  })
  // interruptAfter["triagem_escolher"] pausa aqui — aguarda escolha da lista
  .addEdge("triagem_escolher", "triagem_capturar_escolha")
  .addEdge("triagem_capturar_escolha", "extrator_inicial")
  .addEdge("extrator_inicial", "informativo")
  .addConditionalEdges("informativo", roteador, DESTINOS_ROTEADOR)

  // ── Loop de perguntas: cada node pergunta 1 item e pausa (interruptAfter)
  //    resposta do usuário → extrator → roteador decide a próxima pergunta ─
  .addEdge("familia_pensao",     "extrator")
  .addEdge("trabalhista",        "extrator")
  .addEdge("inss",               "extrator")
  .addEdge("outros",             "extrator")
  .addEdge("dados_pessoais",     "extrator")
  .addEdge("dados_residenciais", "extrator")
  .addEdge("dados_contato",      "extrator")
  .addConditionalEdges("extrator", roteador, DESTINOS_ROTEADOR)

  // ── Envio à DPERJ + encerramento ───────────────────────────────────────
  .addEdge("enviar_dados", "encerramento")
  .addEdge("encerramento", "__end__")

  .compile({
    checkpointer,
    interruptAfter: [
      "lgpd",
      "identificar_assistido",
      "identificar_assistido_invalido",
      "identificar_assistido_confirmar",
      "identificar_assistido_oferecer_cadastro",
      "identificar_assistido_cadastrar",
      "verificar_caso_aberto_aguardar",
      "primeira_mensagem",
      "triagem_confirmar",
      "triagem_escolher",
      "familia_pensao",
      "trabalhista",
      "inss",
      "outros",
      "dados_pessoais",
      "dados_residenciais",
      "dados_contato",
    ],
  });
