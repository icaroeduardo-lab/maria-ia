import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph as graphEstatico, checkpointer } from "./graph.js";
import {
  graphDoFlow,
  subfluxosReferenciados,
  nosExpandidos,
  type FlowRow,
  type FlowNode,
} from "./engine/builder.js";
import { prisma } from "./db.js";
import { montarMetadados, gerarResumoTexto } from "./resumo.js";
import { env } from "./env.js";
import { PERGUNTAS_POR_CHAVE } from "./registro-perguntas.js";
import type { TipoPergunta } from "./perguntas.js";

// Comando do usuário para reiniciar a conversa do zero (qualquer canal,
// inclusive o chat de teste do painel — ver /admin/test-chat).
export const COMANDO_REINICIAR = "#sair";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// primeiro nome do assistido (do cadastro via CPF ou do campo nome), se houver
function primeiroNome(dados?: Record<string, unknown>): string | null {
  if (!dados) return null;
  const rc = dados.resultado_cpf;
  const parsed =
    typeof rc === "string"
      ? (() => {
          try {
            return JSON.parse(rc);
          } catch {
            return null;
          }
        })()
      : rc;
  const nome =
    (parsed as { dados?: { nome?: string } } | null)?.dados?.nome ??
    (typeof dados.nome === "string" ? dados.nome : null);
  return nome ? String(nome).trim().split(/\s+/)[0] : null;
}

// Invoca o grafo com 1 retry para erros transitórios (Bedrock throttling, rede).
async function invokeComRetry(
  graph: typeof graphEstatico,
  input: Parameters<typeof graphEstatico.invoke>[0],
  config: Parameters<typeof graphEstatico.invoke>[1],
  tentativas = 2
) {
  let ultimoErro: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await graph.invoke(input, config);
    } catch (err) {
      ultimoErro = err;
      console.error(`[chat] invoke falhou (tentativa ${i + 1}/${tentativas}):`, err);
      if (i < tentativas - 1) await sleep(800);
    }
  }
  throw ultimoErro;
}

// Carrega os sub-flows referenciados por um flow, e os sub-flows QUE ESSES
// sub-flows referenciam, recursivamente (subfluxo dentro de subfluxo — ex:
// um "Orquestrador" reutilizável que embute Divórcio/Trabalhista/...).
// Sem isso, só o 1º nível carrega e o nó subfluxo aninhado vira pass-through
// sem saída (perguntas/extração do tema nunca rodam).
export async function carregarSubflowsRecursivo(nodesIniciais: unknown): Promise<FlowRow[]> {
  if (!prisma) return [];
  const vistos = new Set<string>();
  const resultado: FlowRow[] = [];
  let pendentes = subfluxosReferenciados(nodesIniciais);
  while (pendentes.length) {
    const novos = pendentes.filter((id) => !vistos.has(id));
    if (!novos.length) break;
    for (const id of novos) vistos.add(id);
    const flows = await prisma.flow.findMany({ where: { id: { in: novos } } });
    resultado.push(...flows);
    pendentes = flows.flatMap((f) => subfluxosReferenciados(f.nodes));
  }
  return resultado;
}

// Compila um flow ESPECÍFICO do banco (por id) em grafo executável — mesma
// expansão de subfluxos (carregarSubflowsRecursivo + nosExpandidos) que
// obterGraph() usa pro flow ativo, mas pra um id explícito em vez do flow
// marcado active. Reaproveitada por:
//  - POST /admin/test-chat (routes/admin.ts): testar um subfluxo isolado no
//    builder, sem depender do flow ativo do painel
//  - obterGraph() abaixo, quando processarMensagem() recebe um flowId
//    explícito (hoje só a ponte Tykhe — pula o MariaIA inteiro e começa
//    direto num fluxo específico, ex: "Pessoa Presa (protótipo IA)", sem
//    precisar tornar aquele fluxo o flow ativo global)
// ok:false distingue 404 (flow não existe) de 422 (existe mas não compila) —
// o chamador HTTP decide o status; processarMensagem() só loga e cai pro
// flow ativo (nunca deixa o assistido travado por um flowId ruim).
export type GrafoPorId =
  | { ok: true; graph: typeof graphEstatico; flowNodes: FlowNode[] | null }
  | { ok: false; status: 404 | 422; erro: string };

export async function carregarGrafoPorId(flowId: string): Promise<GrafoPorId> {
  if (!prisma) return { ok: false, status: 404, erro: "fluxo não encontrado" };
  const flow = await prisma.flow.findUnique({ where: { id: flowId } });
  if (!flow) return { ok: false, status: 404, erro: "fluxo não encontrado" };
  const subflows = await carregarSubflowsRecursivo(flow.nodes);
  try {
    const graph = graphDoFlow(flow, subflows) as typeof graphEstatico;
    const flowNodes = nosExpandidos(flow, subflows);
    return { ok: true, graph, flowNodes };
  } catch (err) {
    return { ok: false, status: 422, erro: `flow inválido: ${String(err)}` };
  }
}

// Grafo a usar: flow explícito (flowId, quando dado — ver carregarGrafoPorId
// acima), senão o flow ativo (compilado dinamicamente, com cache), senão o
// grafo estático padrão. Troca de flow ativo afeta conversas novas.
// flowNodes: nós (principal + sub-flows carregados) do flow em uso, usados
// por tipoPerguntaPendente() abaixo para resolver o tipoPergunta de uma
// chave — null quando é o grafo estático (usa o registro PERGUNTAS_POR_CHAVE).
async function obterGraph(flowId?: string): Promise<{
  graph: typeof graphEstatico;
  flowId: string | null;
  flowNodes: FlowNode[] | null;
}> {
  if (flowId) {
    const carregado = await carregarGrafoPorId(flowId);
    if (carregado.ok) return { graph: carregado.graph, flowId, flowNodes: carregado.flowNodes };
    console.error(
      `[chat] flowId explícito "${flowId}" inválido/não encontrado (${carregado.erro}) — usando flow ativo`
    );
  }
  if (!prisma) return { graph: graphEstatico, flowId: null, flowNodes: null };
  try {
    const ativo = await prisma.flow.findFirst({ where: { active: true } });
    if (!ativo) return { graph: graphEstatico, flowId: null, flowNodes: null };
    const subflows = await carregarSubflowsRecursivo(ativo.nodes);
    // nosExpandidos() roda a MESMA expansão de subfluxos que graphDoFlow usa
    // pra compilar o grafo — garante que os ids batam com ultimaPergunta
    // (ver comentário em nosExpandidos, builder.ts).
    const flowNodes = nosExpandidos(ativo, subflows);
    return { graph: graphDoFlow(ativo, subflows) as typeof graphEstatico, flowId: ativo.id, flowNodes };
  } catch (err) {
    console.error("[engine] falha ao carregar flow ativo, usando grafo estático:", err);
    return { graph: graphEstatico, flowId: null, flowNodes: null };
  }
}

// Resolve o flowId EFETIVO a usar nesta chamada de processarMensagem().
// Se o chamador passou flowId explícito nesta chamada, usa esse valor E
// grava/atualiza (upsert) SessaoFluxo pra essa sessão — cobre tanto a 1ª
// mensagem de uma thread nova quanto uma eventual troca explícita de flow no
// meio da conversa. Se não passou, busca o flowId salvo da 1ª chamada — sem
// isso, uma chamada seguinte da MESMA thread sem flowId (comportamento real
// da Tykhe: só reenvia o campo obrigatório na 1ª chamada, não nas seguintes)
// fazia o LangGraph resumir o checkpoint (estado de um grafo específico, ex:
// "Pessoa Presa") contra o grafo PADRÃO da MariaIA (estruturalmente
// diferente) — na prática a conversa "reiniciava do zero" (saudação/LGPD em
// vez de continuar a pergunta certa). Sem Prisma (sem DATABASE_URL): no-op,
// devolve o parâmetro cru — mesmo comportamento de sempre (web/WhatsApp
// nunca passam flowId, não têm SessaoFluxo pra buscar, não são afetados).
async function resolverFlowId(sessionId: string, flowIdChamada?: string): Promise<string | undefined> {
  if (flowIdChamada) {
    if (prisma) {
      await prisma.sessaoFluxo
        .upsert({
          where: { sessionId },
          update: { flowId: flowIdChamada },
          create: { sessionId, flowId: flowIdChamada },
        })
        .catch((err) => console.error("[chat] falha ao gravar SessaoFluxo:", err));
    }
    return flowIdChamada;
  }
  if (!prisma) return undefined;
  const salvo = await prisma.sessaoFluxo.findUnique({ where: { sessionId } }).catch(() => null);
  return salvo?.flowId ?? undefined;
}

// Apaga o registro SessaoFluxo (se houver) junto com o checkpoint do thread —
// chamar sempre que checkpointer.deleteThread(sessionId) for chamado. Sem
// isso, uma conversa reiniciada do zero (thread_id reaproveitado) herdaria o
// flowId de uma conversa anterior que nem existe mais — mesma classe de bug
// do problema original, só que na direção contrária (flowId "grudado" demais
// em vez de "esquecido" demais).
async function limparSessaoFluxo(sessionId: string): Promise<void> {
  if (!prisma) return;
  await prisma.sessaoFluxo
    .deleteMany({ where: { sessionId } })
    .catch((err) => console.error("[chat] falha ao limpar SessaoFluxo:", err));
}

// Resolve o tipoPergunta de uma chave contra o flow ativo (builder dinâmico —
// flowNodes já expandido via nosExpandidos()) ou, na ausência de flow
// dinâmico (flowNodes null, grafo estático), o registro estático
// (registro-perguntas.ts). Função pura — usada tanto por tipoPerguntaPendente()
// (sessão real) quanto pelo chat de teste do painel (POST /admin/test-chat*,
// ver src/api/routes/admin.ts), que resolve contra o mesmo estado sem reler
// o checkpoint duas vezes.
export function resolverTipoPergunta(chave: string, flowNodes: FlowNode[] | null): TipoPergunta | null {
  if (flowNodes) {
    const node = flowNodes.find((n) => n.type === "pergunta" && (n.data.chave ?? n.id) === chave);
    if (node) return node.data.tipoPergunta ?? "texto";
  }
  return PERGUNTAS_POR_CHAVE.get(chave)?.tipo ?? null;
}

// Descobre o tipoPergunta da pergunta PENDENTE de uma sessão, sem reprocessar
// mensagem — só lê o checkpoint (graph.getState) e resolve `ultimaPergunta`
// (chave) contra o flow ativo (builder dinâmico) ou o registro estático
// (registro-perguntas.ts). Usado pelo WhatsApp para decidir se vale a pena
// baixar mídia recebida (ver processarMensagemWhatsApp em channels/whatsapp.ts)
// — evita custo de download/S3 e mensagem de erro sem sentido fora de contexto.
export async function tipoPerguntaPendente(sessionId: string): Promise<TipoPergunta | null> {
  const { graph, flowNodes } = await obterGraph();
  const config = { configurable: { thread_id: sessionId } };
  const state = await graph.getState(config).catch(() => null);
  const chave = (state?.values as { ultimaPergunta?: string } | undefined)?.ultimaPergunta;
  if (!chave) return null;
  return resolverTipoPergunta(chave, flowNodes);
}

// Status resumido de uma conversa pra consumidores síncronos (ex: Tykhe, que
// espera resposta + status no mesmo request/response — diferente de
// WhatsApp/Telegram, que só disparam a mensagem de saída pro canal sem
// esperar volta).
export type StatusConversa = "em_andamento" | "concluido" | "handoff_humano";

// Processa uma mensagem de qualquer canal (web, whatsapp, telegram ou tykhe),
// preservando o padrão crítico de multi-turn: thread novo → invoke(estado
// inicial); resume → updateState + invoke(null). NUNCA invoke(input
// não-nulo) em thread existente.
//
// dadosIniciais: campos de dadosColetados pra semear ANTES do primeiro invoke —
// só tem efeito quando o thread é NOVO (mesma condição isResuming abaixo já
// usada pra telefone_whatsapp/tem_telefone_whatsapp); em thread existente é
// ignorado silenciosamente (evita reescrever estado no meio da conversa).
// Hoje usado pela ponte Tykhe (dadosConhecidos do body de /api/tykhe/mensagem
// — ver tykhe/mensagem.ts) pra semear resultado_cpf/cpf quando a Tykhe já
// consultou o CPF direto no Verde, fora do motor da Maria.
//
// flowId: roda um fluxo ESPECÍFICO (ver carregarGrafoPorId acima) em vez do
// flow ativo — pula o MariaIA inteiro e começa direto num subfluxo (ex: a
// Tykhe já fez saudação/LGPD/CPF do lado dela e a pessoa já escolheu a
// categoria; não faz sentido reclassificar). O valor EFETIVO usado nesta
// chamada é resolvido por resolverFlowId() logo no topo, NÃO o parâmetro cru:
// se passado, grava/atualiza SessaoFluxo (tabela Prisma) pra essa sessão; se
// omitido, busca o flowId salvo da 1ª chamada dessa sessão — por isso o
// chamador NÃO precisa reenviar flowId em toda chamada (a Tykhe só manda o
// campo obrigatório na 1ª mensagem de um chatId; chamadas seguintes resumem
// pro MESMO flow automaticamente, sem depender de disciplina externa). Uma
// troca explícita de flowId no meio da conversa também é suportada — grava
// por cima do valor salvo. SessaoFluxo é limpa junto com o checkpoint sempre
// que a thread é apagada (#sair, conversa encerrada — ver limparSessaoFluxo).
export async function processarMensagem(
  sessionId: string,
  message: string | undefined,
  canal: "web" | "whatsapp" | "telegram" | "tykhe",
  dadosIniciais?: Record<string, string>,
  flowId?: string
) {
  const flowIdResolvido = await resolverFlowId(sessionId, flowId);
  let { graph, flowId: flowIdEfetivo } = await obterGraph(flowIdResolvido);
  const config = { configurable: { thread_id: sessionId } };

  // comando #sair: reinicia a conversa — apaga o checkpoint do thread.
  // A próxima mensagem começa do zero (saudação). Funciona em web e WhatsApp.
  if (message && message.trim().toLowerCase() === COMANDO_REINICIAR) {
    await checkpointer
      .deleteThread(sessionId)
      .catch((err) => console.error("[chat] falha ao reiniciar thread:", err));
    await limparSessaoFluxo(sessionId);
    // BUG 2026-08-18 (relatado pelo usuário no Telegram): #sair só limpava o
    // checkpoint do LangGraph, nunca o handoffStatus da Conversation — se a
    // sessão tinha entrado em handoff (transferir_humano) antes, o flag
    // ficava preso no banco e toda mensagem seguinte (ex: "oi") caía
    // silenciosamente na regra de "handoff ativo, sem resposta automática"
    // (linha ~173 abaixo), fazendo o bot parecer mudo mesmo após reiniciar.
    // #sair agora libera o handoff também, igual à ação manual do atendente
    // (POST /admin/conversations/:sessionId/handoff/liberar).
    if (prisma) {
      await prisma.conversation
        .update({
          where: { sessionId },
          data: { handoffStatus: null, handoffOperador: null, handoffDesde: null },
        })
        .catch(() => {
          /* conversa pode não existir ainda (ex: 1ª mensagem já é #sair) — ok ignorar */
        });
    }
    const aviso = new AIMessage(
      "Conversa reiniciada. 🔄 Quando quiser, é só mandar uma mensagem que começamos de novo."
    );
    return { result: null, newMessages: [aviso], status: "em_andamento" as StatusConversa, categoria: null };
  }

  // handoff pra atendente humano: bot fica em silêncio (nada de resposta
  // automática) enquanto aguardando ou em atendimento. A mensagem do
  // assistido ainda é persistida no checkpoint (updateState, sem invoke) pra
  // aparecer no histórico da conversa que o operador vê no painel.
  if (prisma) {
    const conversa = await prisma.conversation.findUnique({
      where: { sessionId },
      select: { handoffStatus: true, categoria: true },
    });
    if (conversa?.handoffStatus === "aguardando" || conversa?.handoffStatus === "em_atendimento") {
      if (message) {
        await graph
          .updateState(config, { messages: [new HumanMessage(message)] })
          .catch((err) => console.error("[chat] falha ao registrar mensagem durante handoff:", err));
      }
      return {
        result: null,
        newMessages: [],
        status: "handoff_humano" as StatusConversa,
        categoria: conversa.categoria ?? null,
      };
    }
  }

  const prevState = await graph.getState(config);
  let prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;

  // conversa anterior já encerrou (chegou ao __end__ → sem próximo nó): apaga o
  // checkpoint e recomeça do zero. Sem isso, uma nova mensagem tentaria resumir
  // um grafo terminado (invoke(null) não produz nada) — só #sair destravava.
  if (prevLen > 0 && (prevState.next?.length ?? 0) === 0) {
    await checkpointer
      .deleteThread(sessionId)
      .catch((err) => console.error("[chat] falha ao reiniciar thread encerrado:", err));
    await limparSessaoFluxo(sessionId);
    prevLen = 0;
    // flowIdResolvido veio de uma SessaoFluxo que acabamos de apagar (o
    // chamador NÃO passou flowId explícito nesta chamada) — a conversa que
    // está reiniciando do zero não deve herdar o flow da conversa anterior
    // que nem existe mais (mesma classe de bug do problema original, só que
    // "grudado" demais em vez de "esquecido" demais). Recompila pro flow
    // padrão/ativo antes do invoke inicial abaixo.
    if (!flowId && flowIdResolvido) {
      const recarregado = await obterGraph(undefined);
      graph = recarregado.graph;
      flowIdEfetivo = recarregado.flowId;
    }
  }

  const isResuming = prevLen > 0;

  // "bem-vindo de volta": se o assistido retoma uma conversa em andamento depois
  // de um intervalo (default 60min), saúda antes de repetir a pergunta pendente.
  const ultimaAtividade = prevState.createdAt ? new Date(prevState.createdAt).getTime() : 0;
  const gapMs = Date.now() - ultimaAtividade;
  const RETOMADA_MS = env.retomadaMin() * 60 * 1000;
  const retomandoAposPausa = isResuming && ultimaAtividade > 0 && gapMs > RETOMADA_MS;

  if (isResuming && message) {
    await graph.updateState(config, { messages: [new HumanMessage(message)] });
  }

  // invoke com 1 retry para blips transitórios (ex: Bedrock throttling). Se falhar
  // de vez, devolve um fallback amigável — o assistido nunca fica no escuro e o
  // estado fica intacto (LangGraph não commita super-step que lançou erro → pode
  // reenviar a mesma mensagem).
  // WhatsApp: sessionId = `wa:<wa_id>` (ver channels/whatsapp.ts) — extrai o
  // telefone cru pro gate de elegibilidade por DDD (issue #20260134) usar sem
  // precisar perguntar, e pro cadastro reaproveitar sem perguntar de novo
  // (achado 2026-07-31). Só no invoke inicial, igual `canal` (thread_id não é
  // acessível de dentro de um node `api` — ver achado da investigação).
  // wa_id vem em E.164 sem "+" (ex: "5521999990000", DDI 55 + DDD + número) —
  // tira o DDI pra ficar no formato BR local que o cadastro/Verde esperam
  // (mesmo critério de tamanho já usado em elegibilidade.ts:extrairDdd).
  const waIdCru = canal === "whatsapp" ? sessionId.replace(/^wa:/, "") : "";
  const telefoneWhatsapp = waIdCru.length >= 12 && waIdCru.startsWith("55") ? waIdCru.slice(2) : waIdCru;

  let result: Awaited<ReturnType<typeof invokeComRetry>>;
  try {
    // retry só no resume (invoke(null) idempotente); fresh não re-invoca (input
    // não-nulo em thread existente reiniciaria o grafo — padrão crítico)
    // tem_telefone_whatsapp: "true"/"false" fixos (não o telefone em si) — nó
    // condicao do fluxo não pode rotear por "campo vazio" de forma confiável
    // (label "" colide com "sem label"/fallback no motor, builder.ts ~810),
    // precisa de um valor literal pra dar match. "true"/"false" (não
    // "sim"/"nao") porque resolverCampoCondicao normaliza "sim"→"true" e
    // "não"→"false" automaticamente (pensado pra resposta de pergunta
    // sim_nao) — usar o valor já normalizado evita a conversão surpresa.
    const estadoInicial = {
      canal,
      dadosColetados: {
        telefone_whatsapp: telefoneWhatsapp,
        tem_telefone_whatsapp: telefoneWhatsapp ? "true" : "false",
        ...dadosIniciais,
      },
    };
    result = await invokeComRetry(graph, isResuming ? null : estadoInicial, config, isResuming ? 2 : 1);
  } catch (err) {
    console.error("[chat] erro ao processar mensagem:", err);
    const fallback = new AIMessage(
      "Tive um probleminha técnico agora 😔. Pode me mandar a mensagem de novo? Já volto a te ajudar."
    );
    return { result: null, newMessages: [fallback], status: "em_andamento" as StatusConversa, categoria: null };
  }

  const newMessages = (result.messages as BaseMessage[])
    .slice(prevLen)
    .filter((m) => m.getType() !== "human");

  // antepõe a saudação de retomada (com o nome, se conhecido)
  if (retomandoAposPausa) {
    const nome = primeiroNome(result.dadosColetados as Record<string, unknown>);
    const ola = nome ? `Que bom te ver de novo, ${nome}! 😊` : "Que bom te ver de novo! 😊";
    newMessages.unshift(new AIMessage(`${ola} Vamos continuar de onde paramos.`));
  }

  // estado pós-invoke (mesmo padrão de done que /admin/test-chat usa —
  // montarRespostaTeste em routes/admin.ts): next vazio = chegou num nó
  // encerrar; state.handoff === "aguardando" = nó transferir_humano rodou
  // neste turno. Lido 1x aqui e repassado pra rastrearConversa evitar 2
  // getState idênticos no mesmo turno. Só leitura — não afeta o padrão
  // crítico de multi-turn acima (nenhum invoke/updateState adicional).
  const estadoAtual = await graph.getState(config);
  const emAndamento = (estadoAtual.next?.length ?? 0) > 0;
  const valoresAtuais = estadoAtual.values as Record<string, unknown>;
  const emHandoff = valoresAtuais.handoff === "aguardando";
  const categoriaAtual = (valoresAtuais.categoria as string) || null;
  const status: StatusConversa = emHandoff ? "handoff_humano" : emAndamento ? "em_andamento" : "concluido";

  await rastrearConversa(sessionId, canal, flowIdEfetivo, estadoAtual, emAndamento, emHandoff).catch((err) =>
    console.error("[tracking] falha ao registrar conversa:", err)
  );

  return { result, newMessages, status, categoria: categoriaAtual };
}

// Nota de satisfação (csat, card #20260128): dadosColetados.csat vem de uma
// pergunta de chave "csat" no fluxo — string ou number, sem garantia de
// formato. Só promove pra Conversation.csat quando é um inteiro 1..5; "9",
// "0", "banana" ou decimais (ex: "3.5") são rejeitados sem quebrar o turno.
export function csatValido(bruto: unknown): number | null {
  if (bruto === undefined || bruto === null || bruto === "") return null;
  const n = typeof bruto === "number" ? bruto : Number(bruto);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

// Espelha o estado da conversa no Postgres para o painel admin/analytics.
// Sem DATABASE_URL é no-op — o atendimento nunca depende do tracking.
// emAndamento/emHandoff vêm já calculados de processarMensagem (mesmo
// getState do pós-invoke — evita reler o checkpoint 2x no mesmo turno).
async function rastrearConversa(
  sessionId: string,
  canal: string,
  flowId: string | null,
  atual: Awaited<ReturnType<typeof graphEstatico.getState>>,
  emAndamento: boolean,
  emHandoff: boolean
) {
  if (!prisma) return;
  const v = atual.values as Record<string, unknown>;
  const coletados = (v.dadosColetados as Record<string, unknown>) ?? {};

  // no fim do atendimento: gera resumo + metadados limpos (envio/registro à DPERJ)
  let resumo: string | null = null;
  let metadados: object | null = null;
  if (!emAndamento && !emHandoff) {
    const m = montarMetadados(coletados);
    metadados = m as object;
    resumo = await gerarResumoTexto(m).catch(() => null);
  }

  // csat: promove só quando válido (1..5); fora do range/não numérico fica de
  // fora do update — a coluna simplesmente não é tocada, turno segue normal.
  const csat = csatValido(coletados.csat);
  if (coletados.csat !== undefined && csat === null) {
    console.warn(
      "[tracking] csat inválido/fora do range 1-5, ignorado:",
      String(coletados.csat).slice(0, 20)
    );
  }

  const dados = {
    channel: canal,
    flowId,
    status: emAndamento || emHandoff ? "active" : "completed",
    categoria: (v.categoria as string) || null,
    tags: (v.tags as string[]) ?? [],
    ultimaEtapa: emAndamento ? atual.next[0] : emHandoff ? "transferir_humano" : "fim",
    dadosColetados: coletados as object,
    protocoloDperj: (v.protocolo as string) || null,
    completedAt: emAndamento || emHandoff ? null : new Date(),
    ...(emHandoff && { handoffStatus: "aguardando", handoffDesde: new Date() }),
    ...(resumo !== null && { resumo }),
    ...(metadados !== null && { metadados }),
    ...(csat !== null && { csat }),
  };

  await prisma.conversation.upsert({
    where: { sessionId },
    update: dados,
    create: { sessionId, ...dados },
  });

  // notificação best-effort — nunca bloqueia o atendimento por falha de rede
  if (emHandoff) notificarHandoff(sessionId, canal, (v.categoria as string) || null);
}

function notificarHandoff(sessionId: string, canal: string, categoria: string | null) {
  const url = env.handoffWebhookUrl();
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, canal, categoria, em: new Date().toISOString() }),
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => console.warn("[handoff] notificação falhou:", String(err).slice(0, 120)));
}
