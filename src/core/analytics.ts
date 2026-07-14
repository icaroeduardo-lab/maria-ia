import { prisma } from "./db.js";

// Contador de passagens por nó, por fluxo (funil/drop-off — card #20260119).
// Fire-and-forget: nunca atrasa/derruba o turno do chat por causa de métrica.
export function registrarVisitaNode(flowId: string, nodeId: string): void {
  if (!prisma) return;
  prisma.nodeVisita
    .upsert({
      where: { flowId_nodeId: { flowId, nodeId } },
      create: { flowId, nodeId, total: 1 },
      update: { total: { increment: 1 } },
    })
    .catch((err) => console.warn("[funil] falha ao registrar visita:", String(err).slice(0, 120)));
}
