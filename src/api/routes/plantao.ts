import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";

// Rota de Plantão vigente usada PELO FLUXO — sem JWT, como pessoa-presa.ts e
// assistidos.ts. "API fake" provisória pro subfluxo reutilizável "Plantão"
// (escala de sobreaviso/urgência da Defensoria — aparece em pelo menos 3
// famílias de fluxo legado: Violência Doméstica, Novo caso, Falar de
// processo/intimação).
//
// Simplificação em relação ao legado: lá, /plantao/vigente devolvia até 4
// plantões concorrentes e o fluxo tinha que fazer uma cascata de ifs
// (idPlantao0..3) + checar se cada um era tipo "MUNICIPAL" (que não conta
// como urgência de plantão de verdade) pra decidir qual órgão usar. Aqui a
// rota já resolve isso: retorna o primeiro plantão ativo com tipo != MUNICIPAL,
// se existir. O fluxo só precisa checar um `status` — mesma convenção
// "encontrado"/"nao_encontrado" de orgao-responsavel em pessoa-presa.ts.

interface OrgaoPlantao {
  nome: string;
  telefone: string | null;
  endereco: string | null;
  municipio: string;
  tipo: string;
}

export async function plantaoFlowRoutes(app: FastifyInstance) {
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!;

  // GET /api/plantao/vigente — plantão ativo agora, ignorando tipo MUNICIPAL
  app.get("/api/plantao/vigente", async () => {
    const plantao = await db.plantaoVigente.findFirst({
      where: { ativo: true, tipo: { not: "MUNICIPAL" } },
      orderBy: { createdAt: "desc" },
    });
    console.log(`[plantao] vigente: ${plantao ? `encontrado (${plantao.tipo}/${plantao.municipio})` : "nenhum plantão não-municipal ativo"}`);
    if (!plantao) return { status: "nao_encontrado", orgao: null };
    const orgao: OrgaoPlantao = {
      nome: plantao.nomeOrgao,
      telefone: plantao.telefone,
      endereco: plantao.endereco,
      municipio: plantao.municipio,
      tipo: plantao.tipo,
    };
    return { status: "encontrado", orgao };
  });
}
