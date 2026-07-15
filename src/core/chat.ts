import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph as graphEstatico, checkpointer } from "./graph.js";
import { graphDoFlow, subfluxosReferenciados, type FlowRow } from "./engine/builder.js";
import { prisma } from "./db.js";
import { montarMetadados, gerarResumoTexto } from "./resumo.js";
import { env } from "./env.js";

// Comando do usuário para reiniciar a conversa do zero (qualquer canal,
// inclusive o chat de teste do painel — ver /admin/test-chat).
export const COMANDO_REINICIAR = "#sair";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// primeiro nome do assistido (do cadastro via CPF ou do campo nome), se houver
function primeiroNome(dados?: Record<string, unknown>): string | null {
  if (!dados) return null;
  const rc = dados.resultado_cpf;
  const parsed = typeof rc === "string" ? (() => { try { return JSON.parse(rc); } catch { return null; } })() : rc;
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

// Grafo a usar: flow ativo (compilado dinamicamente, com cache) ou o grafo
// estático padrão. Troca de flow ativo afeta conversas novas.
async function obterGraph(): Promise<{ graph: typeof graphEstatico; flowId: string | null }> {
  if (!prisma) return { graph: graphEstatico, flowId: null };
  try {
    const ativo = await prisma.flow.findFirst({ where: { active: true } });
    if (!ativo) return { graph: graphEstatico, flowId: null };
    const subflows = await carregarSubflowsRecursivo(ativo.nodes);
    return { graph: graphDoFlow(ativo, subflows) as typeof graphEstatico, flowId: ativo.id };
  } catch (err) {
    console.error("[engine] falha ao carregar flow ativo, usando grafo estático:", err);
    return { graph: graphEstatico, flowId: null };
  }
}

// Processa uma mensagem de qualquer canal (web ou whatsapp), preservando o
// padrão crítico de multi-turn: thread novo → invoke(estado inicial);
// resume → updateState + invoke(null). NUNCA invoke(input não-nulo) em thread existente.
export async function processarMensagem(
  sessionId: string,
  message: string | undefined,
  canal: "web" | "whatsapp"
) {
  const { graph, flowId } = await obterGraph();
  const config = { configurable: { thread_id: sessionId } };

  // comando #sair: reinicia a conversa — apaga o checkpoint do thread.
  // A próxima mensagem começa do zero (saudação). Funciona em web e WhatsApp.
  if (message && message.trim().toLowerCase() === COMANDO_REINICIAR) {
    await checkpointer.deleteThread(sessionId).catch((err) =>
      console.error("[chat] falha ao reiniciar thread:", err)
    );
    const aviso = new AIMessage(
      "Conversa reiniciada. 🔄 Quando quiser, é só mandar uma mensagem que começamos de novo."
    );
    return { result: null, newMessages: [aviso] };
  }

  // handoff pra atendente humano: bot fica em silêncio (nada de resposta
  // automática) enquanto aguardando ou em atendimento. A mensagem do
  // assistido ainda é persistida no checkpoint (updateState, sem invoke) pra
  // aparecer no histórico da conversa que o operador vê no painel.
  if (prisma) {
    const conversa = await prisma.conversation.findUnique({
      where: { sessionId },
      select: { handoffStatus: true },
    });
    if (conversa?.handoffStatus === "aguardando" || conversa?.handoffStatus === "em_atendimento") {
      if (message) {
        await graph.updateState(config, { messages: [new HumanMessage(message)] }).catch((err) =>
          console.error("[chat] falha ao registrar mensagem durante handoff:", err)
        );
      }
      return { result: null, newMessages: [] };
    }
  }

  const prevState = await graph.getState(config);
  let prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;

  // conversa anterior já encerrou (chegou ao __end__ → sem próximo nó): apaga o
  // checkpoint e recomeça do zero. Sem isso, uma nova mensagem tentaria resumir
  // um grafo terminado (invoke(null) não produz nada) — só #sair destravava.
  if (prevLen > 0 && (prevState.next?.length ?? 0) === 0) {
    await checkpointer.deleteThread(sessionId).catch((err) =>
      console.error("[chat] falha ao reiniciar thread encerrado:", err)
    );
    prevLen = 0;
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
  let result: Awaited<ReturnType<typeof invokeComRetry>>;
  try {
    // retry só no resume (invoke(null) idempotente); fresh não re-invoca (input
    // não-nulo em thread existente reiniciaria o grafo — padrão crítico)
    result = await invokeComRetry(graph, isResuming ? null : { canal }, config, isResuming ? 2 : 1);
  } catch (err) {
    console.error("[chat] erro ao processar mensagem:", err);
    const fallback = new AIMessage(
      "Tive um probleminha técnico agora 😔. Pode me mandar a mensagem de novo? Já volto a te ajudar."
    );
    return { result: null, newMessages: [fallback] };
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

  await rastrearConversa(sessionId, canal, flowId, graph, config).catch((err) =>
    console.error("[tracking] falha ao registrar conversa:", err)
  );

  return { result, newMessages };
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
async function rastrearConversa(
  sessionId: string,
  canal: string,
  flowId: string | null,
  graph: typeof graphEstatico,
  config: { configurable: { thread_id: string } }
) {
  if (!prisma) return;
  const atual = await graph.getState(config);
  const v = atual.values as Record<string, unknown>;
  const emAndamento = (atual.next?.length ?? 0) > 0;
  const coletados = (v.dadosColetados as Record<string, unknown>) ?? {};

  // nó transferir_humano acabou de rodar nesse invoke: entra em handoff em
  // vez de completar normalmente. O campo `handoff` no state é resetado pelo
  // endpoint /admin/handoff/{sessionId}/liberar (senão ficaria "sticky" no
  // checkpoint e reabriria o handoff no próximo invoke depois de liberado).
  const emHandoff = v.handoff === "aguardando";

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
    console.warn("[tracking] csat inválido/fora do range 1-5, ignorado:", String(coletados.csat).slice(0, 20));
  }

  const dados = {
    channel: canal,
    flowId,
    status: emAndamento || emHandoff ? "active" : "completed",
    categoria: (v.categoria as string) || null,
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
