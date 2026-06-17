import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph as graphEstatico } from "./graph.js";
import { graphDoFlow, subfluxosReferenciados } from "./engine/builder.js";
import { prisma } from "./db.js";
import { montarMetadados, gerarResumoTexto } from "./resumo.js";

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

  const prevState = await graph.getState(config);
  const prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;
  const isResuming = prevLen > 0;

  if (isResuming && message) {
    await graph.updateState(config, { messages: [new HumanMessage(message)] });
  }

  const result = await graph.invoke(isResuming ? null : { canal }, config);

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
