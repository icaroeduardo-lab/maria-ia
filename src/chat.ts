import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { graph } from "./graph.js";
import { prisma } from "./db.js";

// Processa uma mensagem de qualquer canal (web ou whatsapp), preservando o
// padrão crítico de multi-turn: thread novo → invoke(estado inicial);
// resume → updateState + invoke(null). NUNCA invoke(input não-nulo) em thread existente.
export async function processarMensagem(sessionId: string, message: string | undefined, canal: "web" | "whatsapp") {
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

  await rastrearConversa(sessionId, canal, config).catch((err) =>
    console.error("[tracking] falha ao registrar conversa:", err)
  );

  return { result, newMessages };
}

// Espelha o estado da conversa no Postgres para o painel admin/analytics.
// Sem DATABASE_URL é no-op — o atendimento nunca depende do tracking.
async function rastrearConversa(
  sessionId: string,
  canal: string,
  config: { configurable: { thread_id: string } }
) {
  if (!prisma) return;
  const atual = await graph.getState(config);
  const v = atual.values as Record<string, unknown>;
  const emAndamento = (atual.next?.length ?? 0) > 0;

  const dados = {
    channel: canal,
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
