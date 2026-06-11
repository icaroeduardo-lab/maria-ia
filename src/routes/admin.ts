import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { autenticar, exigirAdmin } from "./auth.js";

// API do painel admin (registrada com prefix /admin). Tudo exige JWT;
// mutações exigem role admin. Exige DATABASE_URL (Postgres).
export async function adminRoutes(app: FastifyInstance) {
  if (!prisma) {
    app.all("*", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
    return;
  }
  const db = prisma;

  app.addHook("preHandler", autenticar);

  // ── Fluxos ────────────────────────────────────────────────────────────────
  app.get("/flows", async (req) =>
    db.flow.findMany({
      where: { orgId: req.user.orgId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, active: true, createdAt: true, updatedAt: true },
    })
  );

  app.get("/flows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const flow = await db.flow.findFirst({ where: { id, orgId: req.user.orgId } });
    return flow ?? reply.code(404).send({ erro: "fluxo não encontrado" });
  });

  app.post("/flows", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { name, nodes = [], edges = [] } = (req.body ?? {}) as { name?: string; nodes?: unknown[]; edges?: unknown[] };
    if (!name) return reply.code(400).send({ erro: "name obrigatório" });
    return db.flow.create({ data: { name, nodes: nodes as object[], edges: edges as object[], orgId: req.user.orgId } });
  });

  app.put("/flows/:id", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name, nodes, edges } = (req.body ?? {}) as { name?: string; nodes?: unknown[]; edges?: unknown[] };
    const existe = await db.flow.findFirst({ where: { id, orgId: req.user.orgId } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    return db.flow.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(nodes !== undefined && { nodes: nodes as object[] }),
        ...(edges !== undefined && { edges: edges as object[] }),
      },
    });
  });

  app.delete("/flows/:id", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findFirst({ where: { id, orgId: req.user.orgId } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    await db.flow.delete({ where: { id } });
    return { ok: true };
  });

  // ativa um fluxo (desativa os demais da org) — o engine passa a usá-lo
  app.post("/flows/:id/activate", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findFirst({ where: { id, orgId: req.user.orgId } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    const [, flow] = await db.$transaction([
      db.flow.updateMany({ where: { orgId: req.user.orgId }, data: { active: false } }),
      db.flow.update({ where: { id }, data: { active: true } }),
    ]);
    return flow;
  });

  app.post("/flows/:id/deactivate", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findFirst({ where: { id, orgId: req.user.orgId } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    return db.flow.update({ where: { id }, data: { active: false } });
  });

  // ── Conversas ─────────────────────────────────────────────────────────────
  app.get("/conversations", async (req) => {
    const q = req.query as { status?: string; categoria?: string; channel?: string; page?: string };
    const page = Math.max(1, Number(q.page ?? 1));
    const where = {
      ...(q.status && { status: q.status }),
      ...(q.categoria && { categoria: q.categoria }),
      ...(q.channel && { channel: q.channel }),
    };
    const [total, itens] = await Promise.all([
      db.conversation.count({ where }),
      db.conversation.findMany({ where, orderBy: { startedAt: "desc" }, skip: (page - 1) * 50, take: 50 }),
    ]);
    return { total, page, itens };
  });

  app.get("/conversations/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const conv = await db.conversation.findUnique({ where: { sessionId } });
    return conv ?? reply.code(404).send({ erro: "conversa não encontrada" });
  });

  // ── Analytics ─────────────────────────────────────────────────────────────
  app.get("/analytics/summary", async () => {
    // conversa ativa parada há 24h+ conta como abandonada
    await db.conversation.updateMany({
      where: { status: "active", updatedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
      data: { status: "abandoned" },
    });

    const [total, porStatus, porCategoria, porCanal, abandonoPorEtapa, serieDiaria] = await Promise.all([
      db.conversation.count(),
      db.conversation.groupBy({ by: ["status"], _count: { _all: true } }),
      db.conversation.groupBy({ by: ["categoria"], _count: { _all: true } }),
      db.conversation.groupBy({ by: ["channel"], _count: { _all: true } }),
      db.conversation.groupBy({
        by: ["ultimaEtapa"],
        _count: { _all: true },
        where: { status: { in: ["active", "abandoned"] } },
      }),
      db.$queryRaw`
        SELECT date_trunc('day', "startedAt")::date::text AS dia,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'completed')::int AS concluidas
        FROM "Conversation"
        WHERE "startedAt" > now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
    ]);

    const concluidas = porStatus.find((s) => s.status === "completed")?._count._all ?? 0;
    return {
      total,
      taxaConclusao: total ? concluidas / total : 0,
      porStatus: porStatus.map((s) => ({ status: s.status, total: s._count._all })),
      porCategoria: porCategoria.map((c) => ({ categoria: c.categoria ?? "(sem)", total: c._count._all })),
      porCanal: porCanal.map((c) => ({ canal: c.channel, total: c._count._all })),
      abandonoPorEtapa: abandonoPorEtapa.map((e) => ({ etapa: e.ultimaEtapa ?? "(sem)", total: e._count._all })),
      serieDiaria,
    };
  });

  // ── Usuários ──────────────────────────────────────────────────────────────
  app.get("/users", { preHandler: [exigirAdmin] }, async (req) =>
    db.user.findMany({
      where: { orgId: req.user.orgId },
      select: { id: true, email: true, nome: true, role: true },
    })
  );

  app.post("/users", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { email, senha, nome = "", role = "viewer" } = (req.body ?? {}) as {
      email?: string; senha?: string; nome?: string; role?: string;
    };
    if (!email || !senha) return reply.code(400).send({ erro: "email e senha obrigatórios" });
    if (!["admin", "viewer"].includes(role)) return reply.code(400).send({ erro: "role inválida" });
    const user = await db.user.create({
      data: { email, senha: bcrypt.hashSync(senha, 10), nome, role, orgId: req.user.orgId },
      select: { id: true, email: true, nome: true, role: true },
    });
    return user;
  });
}
