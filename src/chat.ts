import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph as graphEstatico } from "./graph.js";
import { graphDoFlow } from "./engine/builder.js";
import { prisma } from "./db.js";
import { ORG_PADRAO, usoDoMes } from "./orgs.js";

const MSG_LIMITE =
  "No momento não conseguimos iniciar novos atendimentos por aqui. " +
  "Por favor, ligue *129* de segunda a sexta, das 9h às 18h.";

// Grafo a usar: flow ativo DA ORG (compilado dinamicamente, com cache) ou o
// grafo estático padrão. Troca de flow ativo afeta conversas novas.
async function obterGraph(orgId: string): Promise<{ graph: typeof graphEstatico; flowId: string | null }> {
  if (!prisma) return { graph: graphEstatico, flowId: null };
  try {
    const ativo = await prisma.flow.findFirst({ where: { active: true, orgId } });
    if (!ativo) return { graph: graphEstatico, flowId: null };
    return { graph: graphDoFlow(ativo) as typeof graphEstatico, flowId: ativo.id };
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
  canal: "web" | "whatsapp",
  orgId: string = ORG_PADRAO
) {
  const { graph, flowId } = await obterGraph(orgId);
  // thread namespaced por org: sessionIds de orgs diferentes nunca colidem
  const threadId = `${orgId}:${sessionId}`;
  const config = { configurable: { thread_id: threadId } };

  const prevState = await graph.getState(config);
  const prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;
  const isResuming = prevLen > 0;

  // limite do plano: bloqueia só ABERTURA de conversa (em andamento sempre termina)
  if (!isResuming) {
    const uso = await usoDoMes(orgId).catch(() => null);
    if (uso?.excedido) {
      console.warn(`[plano] org ${orgId} excedeu o limite mensal (${uso.usadas}/${uso.limite})`);
      return { result: null, newMessages: [new AIMessage(MSG_LIMITE)], limiteExcedido: true };
    }
  }

  if (isResuming && message) {
    await graph.updateState(config, { messages: [new HumanMessage(message)] });
  }

  const result = await graph.invoke(isResuming ? null : { canal }, config);

  const newMessages = (result.messages as BaseMessage[])
    .slice(prevLen)
    .filter((m) => m.getType() !== "human");

  await rastrearConversa(threadId, canal, orgId, flowId, graph, config).catch((err) =>
    console.error("[tracking] falha ao registrar conversa:", err)
  );

  return { result, newMessages, limiteExcedido: false };
}

// Espelha o estado da conversa no Postgres para o painel admin/analytics.
// Sem DATABASE_URL é no-op — o atendimento nunca depende do tracking.
async function rastrearConversa(
  sessionId: string,
  canal: string,
  orgId: string,
  flowId: string | null,
  graph: typeof graphEstatico,
  config: { configurable: { thread_id: string } }
) {
  if (!prisma) return;
  const atual = await graph.getState(config);
  const v = atual.values as Record<string, unknown>;
  const emAndamento = (atual.next?.length ?? 0) > 0;

  const dados = {
    channel: canal,
    orgId,
    flowId,
    status: emAndamento ? "active" : "completed",
    categoria: (v.categoria as string) || null,
    ultimaEtapa: emAndamento ? atual.next[0] : "fim",
    dadosColetados: (v.dadosColetados as object) ?? {},
    protocoloDperj: (v.protocolo as string) || null,
    completedAt: emAndamento ? null : new Date(),
  };

  await prisma.conversation.upsert({
    where: { sessionId },
    update: dados,
    create: { sessionId, ...dados },
  });
}
