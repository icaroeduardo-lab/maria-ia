import { prisma } from "./db.js";
import { checkpointer } from "./graph.js";

// Conversas em andamento ("active") guardam o estado completo (PII) no checkpointer
// do LangGraph para permitir retomar de onde parou. Se o assistido nunca voltar,
// esse estado fica indefinidamente. Aqui expiramos o checkpoint das conversas
// inativas há mais de CONVERSA_TTL_DIAS — o registro da Conversation (resumo +
// metadados já mascarados) permanece no painel; só o estado pesado/retomável some.
// Ao voltar depois disso, o assistido começa um atendimento novo.
const TTL_DIAS = Number(process.env.CONVERSA_TTL_DIAS ?? 30);

export async function limparConversasInativas(diasTtl = TTL_DIAS): Promise<number> {
  if (!prisma) return 0;
  const cutoff = new Date(Date.now() - diasTtl * 24 * 60 * 60 * 1000);
  const inativas = await prisma.conversation.findMany({
    where: { status: "active", updatedAt: { lt: cutoff } },
    select: { sessionId: true },
  });

  let expiradas = 0;
  for (const { sessionId } of inativas) {
    try {
      await checkpointer.deleteThread(sessionId);
      await prisma.conversation.update({
        where: { sessionId },
        data: { status: "abandoned" },
      });
      expiradas++;
    } catch (err) {
      console.error(`[limpeza] falha ao expirar thread ${sessionId}:`, err);
    }
  }
  if (expiradas) console.log(`[limpeza] expirou ${expiradas} conversa(s) inativa(s) há +${diasTtl}d`);
  return expiradas;
}
