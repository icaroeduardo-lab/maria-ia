import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";

// Rota de Recesso vigente usada PELO FLUXO — sem JWT, como plantao.ts e
// pessoa-presa.ts. "API fake" provisória pro subfluxo reutilizável "Recesso"
// (recesso forense — período em que tribunais/DPERJ reduzem expediente).
// Aparece em pelo menos 4 fluxos legados (Falar de processo/intimação, Novo
// caso, Pessoa presa, Disponibilizar opções).
//
// `status` usa o literal exato que o legado já comparava ("SEM_RECESSO_VIGENTE")
// — mantido pra bater com a convenção que os fluxos legados usavam, mesmo
// não tendo herdado nó nenhum deles ainda (é mais fácil de reconhecer pra
// quem migrar mais fluxos depois).

export async function recessoFlowRoutes(app: FastifyInstance) {
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!;

  // GET /api/recesso/vigente — config única (liga/desliga manual, sem calendário real)
  app.get("/api/recesso/vigente", async () => {
    const config = await db.recessoVigente.findFirst({ orderBy: { updatedAt: "desc" } });
    const emRecesso = config?.ativo ?? false;
    console.log(`[recesso] vigente: ${emRecesso ? "EM RECESSO" : "sem recesso"}`);
    return {
      status: emRecesso ? "RECESSO_VIGENTE" : "SEM_RECESSO_VIGENTE",
      mensagem: emRecesso ? (config?.mensagem ?? "Estamos em recesso no momento.") : null,
    };
  });
}
