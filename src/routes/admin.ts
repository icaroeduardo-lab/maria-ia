import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { prisma } from "../db.js";
import { autenticar, exigirAdmin, exigirSuperadmin } from "./auth.js";
import { PLANOS, usoDoMes } from "../orgs.js";
import { iniciarUpgrade, stripeConfigurado } from "../billing.js";
import { graphDoFlow, graphEstatico } from "../engine/builder.js";

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
      orgId: req.user.orgId,
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
    const conv = await db.conversation.findFirst({ where: { sessionId, orgId: req.user.orgId } });
    return conv ?? reply.code(404).send({ erro: "conversa não encontrada" });
  });

  // ── Analytics ─────────────────────────────────────────────────────────────
  app.get("/analytics/summary", async (req) => {
    const orgId = req.user.orgId;
    // conversa ativa parada há 24h+ conta como abandonada
    await db.conversation.updateMany({
      where: { orgId, status: "active", updatedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
      data: { status: "abandoned" },
    });

    const [total, porStatus, porCategoria, porCanal, abandonoPorEtapa, serieDiaria] = await Promise.all([
      db.conversation.count({ where: { orgId } }),
      db.conversation.groupBy({ by: ["status"], _count: { _all: true }, where: { orgId } }),
      db.conversation.groupBy({ by: ["categoria"], _count: { _all: true }, where: { orgId } }),
      db.conversation.groupBy({ by: ["channel"], _count: { _all: true }, where: { orgId } }),
      db.conversation.groupBy({
        by: ["ultimaEtapa"],
        _count: { _all: true },
        where: { orgId, status: { in: ["active", "abandoned"] } },
      }),
      db.$queryRaw`
        SELECT date_trunc('day', "startedAt")::date::text AS dia,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'completed')::int AS concluidas
        FROM "Conversation"
        WHERE "startedAt" > now() - interval '30 days' AND "orgId" = ${orgId}
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

  // ── Organização (plano, uso, billing) ─────────────────────────────────────
  app.get("/org", async (req) => {
    const org = await db.organization.findUniqueOrThrow({
      where: { id: req.user.orgId },
      select: { id: true, slug: true, name: true, plano: true, limiteConversasMes: true, waPhoneNumberId: true },
    });
    return { ...org, uso: await usoDoMes(org.id), planos: PLANOS, stripe: stripeConfigurado() };
  });

  app.put("/org", { preHandler: [exigirAdmin] }, async (req) => {
    const { name, waPhoneNumberId, waAccessToken } = (req.body ?? {}) as {
      name?: string; waPhoneNumberId?: string; waAccessToken?: string;
    };
    return db.organization.update({
      where: { id: req.user.orgId },
      data: {
        ...(name !== undefined && { name }),
        ...(waPhoneNumberId !== undefined && { waPhoneNumberId: waPhoneNumberId || null }),
        ...(waAccessToken !== undefined && { waAccessToken: waAccessToken || null }),
      },
      select: { id: true, slug: true, name: true, plano: true, waPhoneNumberId: true },
    });
  });

  // upgrade de plano: com Stripe retorna checkoutUrl; sem, aplica direto (mock)
  app.post("/org/upgrade", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { plano } = (req.body ?? {}) as { plano?: string };
    if (!plano || !PLANOS[plano]) return reply.code(400).send({ erro: "plano inválido" });
    const urlRetorno = `${req.protocol}://${req.headers.host}/flows`;
    try {
      return await iniciarUpgrade(req.user.orgId, plano, urlRetorno);
    } catch (err) {
      return reply.code(500).send({ erro: String(err) });
    }
  });

  // ── Organizações (somente superadmin — gestão do SaaS) ───────────────────
  app.get("/orgs", { preHandler: [exigirSuperadmin] }, async () => {
    const orgs = await db.organization.findMany({
      select: { id: true, slug: true, name: true, plano: true, limiteConversasMes: true,
                _count: { select: { users: true, flows: true } } },
      orderBy: { name: "asc" },
    });
    return Promise.all(orgs.map(async (o) => ({ ...o, uso: await usoDoMes(o.id) })));
  });

  app.post("/orgs", { preHandler: [exigirSuperadmin] }, async (req, reply) => {
    const { name, slug, plano = "free", adminEmail, adminSenha } = (req.body ?? {}) as {
      name?: string; slug?: string; plano?: string; adminEmail?: string; adminSenha?: string;
    };
    if (!name || !slug || !adminEmail || !adminSenha) {
      return reply.code(400).send({ erro: "name, slug, adminEmail e adminSenha obrigatórios" });
    }
    if (!/^[a-z0-9-]{2,30}$/.test(slug)) {
      return reply.code(400).send({ erro: "slug inválido (a-z, 0-9, hífen)" });
    }
    if (!PLANOS[plano]) return reply.code(400).send({ erro: "plano inválido" });

    const org = await db.organization.create({
      data: {
        name, slug, plano,
        limiteConversasMes: PLANOS[plano].limiteConversasMes,
        users: {
          create: { email: adminEmail, senha: bcrypt.hashSync(adminSenha, 10), nome: "Admin", role: "admin" },
        },
      },
      select: { id: true, slug: true, name: true, plano: true },
    });
    return org;
  });

  // ── Chat de teste (não conta nas analytics, não bloqueia por plano) ──────────
  app.post("/test-chat", async (req, reply) => {
    const { flowId, sessionId, message } = (req.body ?? {}) as {
      flowId?: string;
      sessionId?: string;
      message?: string;
    };
    if (!sessionId) return reply.code(400).send({ erro: "sessionId obrigatório" });

    // carrega o flow específico (ou o estático se omitido)
    let graph = graphEstatico as ReturnType<typeof graphDoFlow>;
    if (flowId) {
      const flow = await db.flow.findFirst({ where: { id: flowId, orgId: req.user.orgId } });
      if (!flow) return reply.code(404).send({ erro: "fluxo não encontrado" });
      try {
        graph = graphDoFlow(flow) as typeof graph;
      } catch (err) {
        return reply.code(422).send({ erro: `flow inválido: ${String(err)}` });
      }
    }

    // prefixo "test:" isola sessões de teste dos checkpoints reais
    const threadId = `test:${req.user.orgId}:${flowId ?? "static"}:${sessionId}`;
    const config = { configurable: { thread_id: threadId } };

    const prevState = await graph.getState(config);
    const prevLen = (prevState.values?.messages as unknown[])?.length ?? 0;
    const isResuming = prevLen > 0;

    if (isResuming && message) {
      await graph.updateState(config, { messages: [new HumanMessage(message)] });
    }

    const result = await graph.invoke(isResuming ? null : { canal: "web" }, config);

    const newMessages = (result.messages as BaseMessage[])
      .slice(prevLen)
      .filter((m) => m.getType() !== "human");

    const estadoFinal = await graph.getState(config);
    const done = (estadoFinal.next?.length ?? 0) === 0;

    return {
      messages: newMessages.map((m) => ({ role: m.getType(), content: m.content })),
      done,
      dadosColetados: (estadoFinal.values as Record<string, unknown>)?.dadosColetados ?? {},
    };
  });
}
