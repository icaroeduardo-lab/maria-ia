import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { prisma } from "../../core/db.js";
import { autenticar, exigirAdmin } from "./auth.js";
import { graphDoFlow, graphEstatico, subfluxosReferenciados, type FlowNode, type FlowEdge } from "../../core/engine/builder.js";
import { validarFlow } from "../../core/engine/validar.js";
import { ESTILO_DEFAULT, invalidarEstilo } from "../../core/config.js";
import { montarMetadados, gerarResumoTexto, type Metadados } from "../../core/resumo.js";
import { mascararAssistido } from "../../core/mask.js";

// API do painel admin (registrada com prefix /admin). Tudo exige JWT;
// mutações exigem role admin. Exige DATABASE_URL (Postgres).
export async function adminRoutes(app: FastifyInstance) {
  if (!prisma) {
    app.all("*", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
    return;
  }
  const db = prisma;

  app.addHook("preHandler", autenticar);

  // registra acesso a PII (quem revelou o quê)
  const registrarAuditoria = async (user: { sub: string; email: string }, alvoTipo: string, alvoId: string) => {
    await db.auditLog.create({
      data: { userId: user.sub, userEmail: user.email, acao: "revelar", alvoTipo, alvoId },
    }).catch((e) => console.error("[auditoria] falha:", e));
  };

  // ── Fluxos ────────────────────────────────────────────────────────────────
  app.get("/flows", async () =>
    db.flow.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, active: true, createdAt: true, updatedAt: true },
    })
  );

  app.get("/flows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const flow = await db.flow.findUnique({ where: { id } });
    return flow ?? reply.code(404).send({ erro: "fluxo não encontrado" });
  });

  // valida um fluxo (estrutural + tentativa de compilar) antes/depois de salvar
  app.get("/flows/:id/validar", async (req, reply) => {
    const { id } = req.params as { id: string };
    const flow = await db.flow.findUnique({ where: { id } });
    if (!flow) return reply.code(404).send({ erro: "fluxo não encontrado" });

    const nodes = (flow.nodes ?? []) as unknown as FlowNode[];
    const edges = (flow.edges ?? []) as unknown as FlowEdge[];
    const r = validarFlow(nodes, edges);

    // subfluxos referenciados precisam existir
    const refs = subfluxosReferenciados(nodes);
    if (refs.length) {
      const existentes = new Set(
        (await db.flow.findMany({ where: { id: { in: refs } }, select: { id: true } })).map((f) => f.id)
      );
      for (const ref of refs) {
        if (!existentes.has(ref)) { r.erros.push(`subfluxo referenciado não existe: ${ref}`); r.ok = false; }
      }
    }

    // tentativa real de compilar (pega erros que a checagem estrutural não vê)
    try {
      const subflows = refs.length ? await db.flow.findMany({ where: { id: { in: refs } } }) : [];
      graphDoFlow(flow, subflows);
    } catch (err) {
      r.erros.push(`falha ao compilar: ${String(err).slice(0, 200)}`);
      r.ok = false;
    }

    return r;
  });

  app.post("/flows", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { name, nodes = [], edges = [] } = (req.body ?? {}) as { name?: string; nodes?: unknown[]; edges?: unknown[] };
    if (!name) return reply.code(400).send({ erro: "name obrigatório" });
    return db.flow.create({ data: { name, nodes: nodes as object[], edges: edges as object[] } });
  });

  app.put("/flows/:id", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name, nodes, edges } = (req.body ?? {}) as { name?: string; nodes?: unknown[]; edges?: unknown[] };
    const existe = await db.flow.findUnique({ where: { id } });
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
    const existe = await db.flow.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    await db.flow.delete({ where: { id } });
    return { ok: true };
  });

  // ativa um fluxo (desativa os demais) — o engine passa a usá-lo
  app.post("/flows/:id/activate", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    const [, flow] = await db.$transaction([
      db.flow.updateMany({ data: { active: false } }),
      db.flow.update({ where: { id }, data: { active: true } }),
    ]);
    return flow;
  });

  app.post("/flows/:id/deactivate", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findUnique({ where: { id } });
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
    if (!conv) return reply.code(404).send({ erro: "conversa não encontrada" });
    // mascara o assistido dentro dos metadados (PII)
    const md = conv.metadados as { assistido?: Record<string, unknown> } | null;
    if (md?.assistido) {
      return { ...conv, metadados: { ...md, assistido: mascararAssistido(md.assistido) } };
    }
    return conv;
  });

  // revela os dados do assistido de uma conversa (admin, auditado)
  app.post("/conversations/:sessionId/revelar", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const conv = await db.conversation.findUnique({ where: { sessionId } });
    if (!conv) return reply.code(404).send({ erro: "conversa não encontrada" });
    await registrarAuditoria(req.user, "conversa", sessionId);
    const md = conv.metadados as { assistido?: Record<string, unknown> } | null;
    return { assistido: md?.assistido ?? null };
  });

  // log de auditoria (admin) — quem revelou PII
  app.get("/audit", { preHandler: [exigirAdmin] }, async (req) => {
    const page = Math.max(1, Number((req.query as { page?: string }).page ?? 1));
    const [total, itens] = await Promise.all([
      db.auditLog.count(),
      db.auditLog.findMany({ orderBy: { criadoEm: "desc" }, skip: (page - 1) * 50, take: 50 }),
    ]);
    return { total, page, itens };
  });

  // histórico de mensagens da conversa (lido do checkpoint LangGraph — checkpointer
  // compartilhado; thread_id = sessionId). Retorna role + content (texto/blocos).
  app.get("/conversations/:sessionId/historico", async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    try {
      const st = await graphEstatico.getState({ configurable: { thread_id: sessionId } });
      const msgs = ((st.values?.messages as { getType: () => string; content: unknown }[]) ?? []).map((m) => ({
        role: m.getType(),
        content: m.content,
      }));
      return { messages: msgs };
    } catch {
      return { messages: [] };
    }
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

  // ── Usuários (operadores do painel) ─────────────────────────────────────────
  app.get("/users", { preHandler: [exigirAdmin] }, async () =>
    db.user.findMany({ select: { id: true, email: true, nome: true, role: true } })
  );

  app.post("/users", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { email, senha, nome = "", role = "viewer" } = (req.body ?? {}) as {
      email?: string; senha?: string; nome?: string; role?: string;
    };
    if (!email || !senha) return reply.code(400).send({ erro: "email e senha obrigatórios" });
    if (!["admin", "viewer"].includes(role)) return reply.code(400).send({ erro: "role inválida" });
    return db.user.create({
      data: { email, senha: bcrypt.hashSync(senha, 10), nome, role },
      select: { id: true, email: true, nome: true, role: true },
    });
  });

  // ── Assistidos (cidadãos) — CRUD do painel ──────────────────────────────────
  const CAMPOS_ASSISTIDO = [
    "nome", "dataNascimento", "nomeMae", "situacao",
    "municipio", "uf", "telefone", "email", "cep", "bairro", "logradouro", "numero",
  ] as const;
  const limparCampos = (body: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    for (const c of CAMPOS_ASSISTIDO) {
      const v = body[c];
      if (typeof v === "string") out[c] = v.trim();
    }
    return out;
  };

  app.get("/assistidos", async (req) => {
    const q = req.query as { busca?: string; page?: string };
    const page = Math.max(1, Number(q.page ?? 1));
    const busca = (q.busca ?? "").trim();
    const where = busca
      ? {
          OR: [
            { cpf: { contains: busca.replace(/\D/g, "") } },
            { nome: { contains: busca, mode: "insensitive" as const } },
          ],
        }
      : {};
    const [total, itens] = await Promise.all([
      db.assistido.count({ where }),
      db.assistido.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * 50, take: 50 }),
    ]);
    // lista sempre mascarada (PII)
    return { total, page, itens: itens.map((a) => mascararAssistido(a)) };
  });

  // detalhe: admin recebe completo (registrado em auditoria); viewer recebe mascarado
  app.get("/assistidos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await db.assistido.findUnique({ where: { id } });
    if (!a) return reply.code(404).send({ erro: "assistido não encontrado" });
    if (req.user.role !== "admin") return mascararAssistido(a);
    await registrarAuditoria(req.user, "assistido", id);
    return a;
  });

  app.post("/assistidos", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cpf = String(body.cpf ?? "").replace(/\D/g, "");
    const campos = limparCampos(body);
    if (cpf.length !== 11) return reply.code(400).send({ erro: "cpf inválido (11 dígitos)" });
    if (!campos.nome) return reply.code(400).send({ erro: "nome obrigatório" });
    const existe = await db.assistido.findUnique({ where: { cpf } });
    if (existe) return reply.code(409).send({ erro: "CPF já cadastrado" });
    return db.assistido.create({ data: { cpf, nome: campos.nome, ...campos } });
  });

  app.put("/assistidos/:id", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.assistido.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "assistido não encontrado" });
    const campos = limparCampos((req.body ?? {}) as Record<string, unknown>);
    return db.assistido.update({ where: { id }, data: campos });
  });

  app.delete("/assistidos/:id", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.assistido.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "assistido não encontrado" });
    await db.assistido.delete({ where: { id } });
    return { ok: true };
  });

  // ── Configuração: preâmbulo de estilo da IA ─────────────────────────────────
  app.get("/config", async () => {
    const c = await db.config.findUnique({ where: { id: "default" } });
    return { estiloPrompt: c?.estiloPrompt ?? "", conversacional: c?.conversacional ?? true, padrao: ESTILO_DEFAULT };
  });

  app.put("/config", { preHandler: [exigirAdmin] }, async (req) => {
    const { estiloPrompt, conversacional } = (req.body ?? {}) as { estiloPrompt?: string; conversacional?: boolean };
    const c = await db.config.upsert({
      where: { id: "default" },
      update: {
        ...(estiloPrompt !== undefined && { estiloPrompt }),
        ...(conversacional !== undefined && { conversacional }),
      },
      create: { id: "default", estiloPrompt: estiloPrompt ?? "", conversacional: conversacional ?? true },
    });
    invalidarEstilo();
    return c;
  });

  // ── Chat de teste (não conta nas analytics) ─────────────────────────────────
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
      const flow = await db.flow.findUnique({ where: { id: flowId } });
      if (!flow) return reply.code(404).send({ erro: "fluxo não encontrado" });
      const refs = subfluxosReferenciados(flow.nodes);
      const subflows = refs.length ? await db.flow.findMany({ where: { id: { in: refs } } }) : [];
      try {
        graph = graphDoFlow(flow, subflows) as typeof graph;
      } catch (err) {
        return reply.code(422).send({ erro: `flow inválido: ${String(err)}` });
      }
    }

    // prefixo "test:" isola sessões de teste dos checkpoints reais
    const threadId = `test:${flowId ?? "static"}:${sessionId}`;
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
    const coletados = ((estadoFinal.values as Record<string, unknown>)?.dadosColetados ?? {}) as Record<string, unknown>;

    // ao encerrar, devolve resumo + metadados limpos (pra visualizar o fechamento)
    let resumo: string | undefined;
    let metadados: object | undefined;
    if (done) {
      metadados = montarMetadados(coletados);
      resumo = await gerarResumoTexto(metadados as Metadados).catch(() => undefined);
    }

    return {
      messages: newMessages.map((m) => ({ role: m.getType(), content: m.content })),
      done,
      dadosColetados: coletados,
      ...(resumo !== undefined && { resumo }),
      ...(metadados !== undefined && { metadados }),
    };
  });
}
