import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph as graphEstatico, checkpointer } from "./graph.js";
import { graphDoFlow, subfluxosReferenciados } from "./engine/builder.js";
import { prisma } from "./db.js";
import { montarMetadados, gerarResumoTexto } from "./resumo.js";

// Comando do usuário para reiniciar a conversa do zero (qualquer canal).
const COMANDO_REINICIAR = "#sair";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// Grafo a usar: flow ativo (compilado dinamicamente, com cache) ou o grafo
// estático padrão. Troca de flow ativo afeta conversas novas.
async function obterGraph(): Promise<{ graph: typeof graphEstatico; flowId: string | null }> {
  if (!prisma) return { graph: graphEstatico, flowId: null };
  try {
    const ativo = await prisma.flow.findFirst({ where: { active: true } });
    if (!ativo) return { graph: graphEstatico, flowId: null };
    const refs = subfluxosReferenciados(ativo.nodes);
    const subflows = refs.length ? await prisma.flow.findMany({ where: { id: { in: refs } } }) : [];
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

  if (isResuming && message) {
    await graph.updateState(config, { messages: [new HumanMessage(message)] });
  }

  // invoke com 1 retry para blips transitórios (ex: Bedrock throttling). Se falhar
  // de vez, devolve um fallback amigável — o assistido nunca fica no escuro e o
  // estado fica intacto (LangGraph não commita super-step que lançou erro → pode
  // reenviar a mesma mensagem).
  let result;
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

  await rastrearConversa(sessionId, canal, flowId, graph, config).catch((err) =>
    console.error("[tracking] falha ao registrar conversa:", err)
  );

  return { result, newMessages };
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

  // no fim do atendimento: gera resumo + metadados limpos (envio/registro à DPERJ)
  let resumo: string | null = null;
  let metadados: object | null = null;
  if (!emAndamento) {
    const m = montarMetadados(coletados);
    metadados = m as object;
    resumo = await gerarResumoTexto(m).catch(() => null);
  }

  const dados = {
    channel: canal,
    flowId,
    status: emAndamento ? "active" : "completed",
    categoria: (v.categoria as string) || null,
    ultimaEtapa: emAndamento ? atual.next[0] : "fim",
    dadosColetados: coletados as object,
    protocoloDperj: (v.protocolo as string) || null,
    completedAt: emAndamento ? null : new Date(),
    ...(resumo !== null && { resumo }),
    ...(metadados !== null && { metadados }),
  };

  await prisma.conversation.upsert({
    where: { sessionId },
    update: dados,
    create: { sessionId, ...dados },
  });
}
