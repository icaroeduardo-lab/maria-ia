import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import fastifyMultipart from "@fastify/multipart";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { enviarWhatsApp } from "../../core/channels/whatsapp.js";
import { prisma } from "../../core/db.js";
import { env } from "../../core/env.js";
import { autenticar, exigirAdmin } from "./auth.js";
import { graphDoFlow, graphEstatico, subfluxosReferenciados, type FlowNode, type FlowEdge } from "../../core/engine/builder.js";
import { checkpointer } from "../../core/graph.js";
import { COMANDO_REINICIAR, carregarSubflowsRecursivo } from "../../core/chat.js";
import { validarFlow } from "../../core/engine/validar.js";
import { ESTILO_DEFAULT, invalidarEstilo } from "../../core/config.js";
import { montarMetadados, gerarResumoTexto, type Metadados } from "../../core/resumo.js";
import { mascararAssistido } from "../../core/mask.js";

// API do painel admin (registrada com prefix /admin). Tudo exige JWT;
// mutações exigem role admin. Exige DATABASE_URL (Postgres).
export async function adminRoutes(app: FastifyInstance) {
  // sem banco: rotas continuam registradas (conjunto determinístico — o guard
  // do openapi depende disso), mas todas respondem 503 via preHandler
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!; // preHandler acima garante que handler não roda sem banco

  app.addHook("preHandler", autenticar);
  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // ── Upload de imagem (p/ nós mensagem/pergunta do builder) ────────────────
  // Re-encoda com sharp (remove EXIF/metadados), grava no S3 público do projeto
  // e devolve a URL permanente. webp converte p/ jpeg/png (WhatsApp não aceita
  // webp como imagem comum). Key por hash do conteúdo → dedup e cache imutável.
  const s3 = new S3Client({ region: env.awsRegion() });
  app.post("/upload", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const file = await req.file().catch(() => null);
    if (!file) return reply.code(400).send({ erro: "envie um arquivo (multipart, campo 'file')" });

    let bruto: Buffer;
    try {
      bruto = await file.toBuffer();
    } catch {
      return reply.code(413).send({ erro: "arquivo grande demais (máx 5MB)" });
    }

    let meta: sharp.Metadata;
    try {
      meta = await sharp(bruto).metadata();
    } catch {
      return reply.code(415).send({ erro: "arquivo não é uma imagem válida" });
    }
    if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
      return reply.code(415).send({ erro: `formato não suportado: ${meta.format ?? "?"} (aceitos: jpeg, png, webp)` });
    }

    const formato = meta.format === "webp" ? (meta.hasAlpha ? "png" : "jpeg") : meta.format;
    // rotate() aplica a orientação EXIF; o re-encode descarta os metadados
    const corpo = await sharp(bruto).rotate().toFormat(formato as "jpeg" | "png").toBuffer();
    const hash = createHash("sha1").update(corpo).digest("hex").slice(0, 16);
    const key = `uploads/${hash}.${formato === "jpeg" ? "jpg" : formato}`;

    await s3.send(new PutObjectCommand({
      Bucket: env.s3Bucket(),
      Key: key,
      Body: corpo,
      ContentType: `image/${formato}`,
      CacheControl: "public, max-age=31536000, immutable",
    }));

    return { url: `https://${env.s3Bucket()}.s3.${env.awsRegion()}.amazonaws.com/${key}` };
  });

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
      select: { id: true, name: true, active: true, isTemplate: true, createdAt: true, updatedAt: true },
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

    // subfluxos referenciados (recursivo — inclui subfluxo dentro de subfluxo) precisam existir
    const refs = subfluxosReferenciados(nodes);
    const subflows = await carregarSubflowsRecursivo(nodes);
    if (refs.length) {
      const existentes = new Set(subflows.map((f) => f.id));
      for (const ref of refs) {
        if (!existentes.has(ref)) { r.erros.push(`subfluxo referenciado não existe: ${ref}`); r.ok = false; }
      }
    }

    // tentativa real de compilar (pega erros que a checagem estrutural não vê)
    try {
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
    const { name, nodes, edges, updatedAt } = (req.body ?? {}) as {
      name?: string; nodes?: unknown[]; edges?: unknown[]; updatedAt?: string;
    };
    const existe = await db.flow.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    // lock otimista: cliente manda o updatedAt que carregou; se o flow mudou
    // nesse meio-tempo (outro editor salvou), 409 — evita sobrescrita silenciosa.
    // Campo opcional: sem updatedAt o save é incondicional (compatível).
    if (updatedAt && new Date(updatedAt).getTime() !== existe.updatedAt.getTime()) {
      return reply.code(409).send({
        erro: "fluxo foi alterado por outra pessoa — recarregue antes de salvar",
        updatedAt: existe.updatedAt,
      });
    }
    // versiona ANTES de sobrescrever: snapshot do estado atual → histórico/rollback
    await criarVersao(id, existe, req.user.email);
    return db.flow.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(nodes !== undefined && { nodes: nodes as object[] }),
        ...(edges !== undefined && { edges: edges as object[] }),
      },
    });
  });

  // snapshot do estado ATUAL do flow (chamado antes de sobrescrever/restaurar)
  const criarVersao = async (
    flowId: string,
    atual: { name: string; nodes: unknown; edges: unknown },
    autor?: string
  ) => {
    const ultima = await db.flowVersion.findFirst({
      where: { flowId },
      orderBy: { versao: "desc" },
      select: { versao: true },
    });
    await db.flowVersion.create({
      data: {
        flowId,
        versao: (ultima?.versao ?? 0) + 1,
        name: atual.name,
        nodes: atual.nodes as object[],
        edges: atual.edges as object[],
        autor,
      },
    });
  };

  // histórico de versões (sem nodes/edges — leve pra listar)
  app.get("/flows/:id/versoes", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findUnique({ where: { id }, select: { id: true } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    return db.flowVersion.findMany({
      where: { flowId: id },
      orderBy: { versao: "desc" },
      select: { versao: true, name: true, autor: true, criadoEm: true },
    });
  });

  // detalhe de uma versão (com nodes/edges — pra preview no canvas)
  app.get("/flows/:id/versoes/:versao", async (req, reply) => {
    const { id, versao } = req.params as { id: string; versao: string };
    const v = await db.flowVersion.findUnique({
      where: { flowId_versao: { flowId: id, versao: Number(versao) } },
    });
    return v ?? reply.code(404).send({ erro: "versão não encontrada" });
  });

  // restaura uma versão (o estado atual vira uma nova versão antes — restore é reversível)
  app.post("/flows/:id/versoes/:versao/restaurar", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id, versao } = req.params as { id: string; versao: string };
    const [flow, v] = await Promise.all([
      db.flow.findUnique({ where: { id } }),
      db.flowVersion.findUnique({ where: { flowId_versao: { flowId: id, versao: Number(versao) } } }),
    ]);
    if (!flow) return reply.code(404).send({ erro: "fluxo não encontrado" });
    if (!v) return reply.code(404).send({ erro: "versão não encontrada" });
    await criarVersao(id, flow, req.user.email);
    return db.flow.update({
      where: { id },
      data: { name: v.name, nodes: v.nodes as object[], edges: v.edges as object[] },
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

  // catálogo de templates (card #20260127) — metadado, não cria FlowVersion
  // (não é uma mudança de conteúdo, é só uma flag de catalogação)
  app.post("/flows/:id/marcar-template", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    return db.flow.update({ where: { id }, data: { isTemplate: true } });
  });

  app.post("/flows/:id/desmarcar-template", { preHandler: [exigirAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existe = await db.flow.findUnique({ where: { id } });
    if (!existe) return reply.code(404).send({ erro: "fluxo não encontrado" });
    return db.flow.update({ where: { id }, data: { isTemplate: false } });
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
    // select enxuto: SEM metadados/dadosColetados/resumo — carregam PII sem
    // máscara (LGPD) e a listagem não precisa deles; detalhe mascara, revelar audita
    const [total, itens] = await Promise.all([
      db.conversation.count({ where }),
      db.conversation.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * 50,
        take: 50,
        select: {
          id: true, sessionId: true, channel: true, flowId: true, status: true,
          categoria: true, ultimaEtapa: true, protocoloDperj: true,
          startedAt: true, updatedAt: true, completedAt: true,
        },
      }),
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

  // ── Handoff pra atendente humano (card #20260117) ─────────────────────────

  // fila de conversas em handoff — sem status = todas (aguardando + em_atendimento)
  app.get("/handoff", async (req) => {
    const { status } = req.query as { status?: string };
    const where = status ? { handoffStatus: status } : { handoffStatus: { not: null } };
    const itens = await db.conversation.findMany({
      where,
      orderBy: { handoffDesde: "asc" },
      select: {
        id: true, sessionId: true, channel: true, categoria: true,
        handoffStatus: true, handoffOperador: true, handoffDesde: true,
      },
    });
    return { itens };
  });

  // operador assume a conversa — bot já está pausado (processarMensagem);
  // aqui só registra quem assumiu
  app.post("/handoff/:sessionId/assumir", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const conv = await db.conversation.findUnique({ where: { sessionId } });
    if (!conv) return reply.code(404).send({ erro: "conversa não encontrada" });
    if (conv.handoffStatus !== "aguardando")
      return reply.code(409).send({ erro: "conversa não está aguardando atendente" });
    await db.conversation.update({
      where: { sessionId },
      data: { handoffStatus: "em_atendimento", handoffOperador: req.user.email, handoffDesde: new Date() },
    });
    return { ok: true };
  });

  // grafo usado pela conversa (flow salvo nela, ou estático) — usado por
  // /liberar e /responder pra chamar graph.updateState no thread certo
  async function grafoDaConversa(flowId: string | null): Promise<ReturnType<typeof graphDoFlow>> {
    let graph = graphEstatico as ReturnType<typeof graphDoFlow>;
    if (flowId) {
      const flow = await db.flow.findUnique({ where: { id: flowId } });
      if (flow) {
        const subflows = await carregarSubflowsRecursivo(flow.nodes);
        graph = graphDoFlow(flow, subflows) as typeof graph;
      }
    }
    return graph;
  }

  // libera de volta pro bot: reseta o campo `handoff` no checkpoint do
  // LangGraph (senão fica "sticky" e reabre o handoff no próximo invoke — ver
  // core/chat.ts rastrearConversa) e limpa o status. Próxima mensagem do
  // assistido já retoma o grafo no próximo nó normalmente.
  app.post("/handoff/:sessionId/liberar", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const conv = await db.conversation.findUnique({ where: { sessionId } });
    if (!conv) return reply.code(404).send({ erro: "conversa não encontrada" });
    if (!conv.handoffStatus) return reply.code(409).send({ erro: "conversa não está em handoff" });

    const graph = await grafoDaConversa(conv.flowId);
    await graph.updateState({ configurable: { thread_id: sessionId } }, { handoff: "" });

    await db.conversation.update({
      where: { sessionId },
      data: { handoffStatus: null, handoffOperador: null, handoffDesde: null },
    });
    return { ok: true };
  });

  // operador responde diretamente (fora do fluxo automático) — grava a
  // resposta no checkpoint (aparece no histórico) e envia de verdade pro
  // canal (WhatsApp real; web é lido via /historico, sem push separado)
  app.post("/handoff/:sessionId/responder", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const { message } = (req.body ?? {}) as { message?: string };
    if (!message?.trim()) return reply.code(400).send({ erro: "message obrigatório" });

    const conv = await db.conversation.findUnique({ where: { sessionId } });
    if (!conv) return reply.code(404).send({ erro: "conversa não encontrada" });
    if (conv.handoffStatus !== "em_atendimento")
      return reply.code(409).send({ erro: "conversa não está em atendimento (assuma primeiro)" });

    const resposta = new AIMessage(message.trim());
    const graph = await grafoDaConversa(conv.flowId);
    await graph.updateState({ configurable: { thread_id: sessionId } }, { messages: [resposta] });

    if (conv.channel === "whatsapp") {
      const numero = sessionId.replace(/^wa:/, "");
      await enviarWhatsApp(numero, [resposta]).catch((err) =>
        console.error("[handoff] falha ao enviar resposta via WhatsApp:", err)
      );
    }
    return { ok: true };
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

    const [
      total,
      porStatus,
      porCategoria,
      porCanal,
      abandonoPorEtapa,
      serieDiaria,
      mediaCsatAgg,
      csatPorCategoria,
      csatPorFluxo,
    ] = await Promise.all([
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
      // csat (card #20260128): conversas sem nota (csat: null) são excluídas
      // da média via where — nunca contam como 0.
      db.conversation.aggregate({ _avg: { csat: true }, where: { csat: { not: null } } }),
      db.conversation.groupBy({
        by: ["categoria"],
        _avg: { csat: true },
        where: { csat: { not: null } },
      }),
      db.conversation.groupBy({
        by: ["flowId"],
        _avg: { csat: true },
        where: { csat: { not: null } },
      }),
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
      mediaCsat: mediaCsatAgg._avg.csat ?? null,
      csatPorCategoria: csatPorCategoria.map((c) => ({
        categoria: c.categoria ?? "(sem)",
        media: c._avg.csat ?? 0,
      })),
      csatPorFluxo: csatPorFluxo.map((f) => ({
        flowId: f.flowId ?? "(estático)",
        media: f._avg.csat ?? 0,
      })),
    };
  });

  // Funil por nó — passagens acumuladas por nó DESTE fluxo (card #20260119).
  // Front calcula % de abandono relativo usando os edges do próprio Flow.
  app.get("/analytics/funil/:flowId", async (req, reply) => {
    const { flowId } = req.params as { flowId: string };
    const flow = await db.flow.findUnique({ where: { id: flowId }, select: { id: true } });
    if (!flow) return reply.code(404).send({ erro: "fluxo não encontrado" });

    const visitas = await db.nodeVisita.findMany({
      where: { flowId },
      select: { nodeId: true, total: true },
      orderBy: { total: "desc" },
    });
    return { nodes: visitas };
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

    // prefixo "test:" isola sessões de teste dos checkpoints reais
    const threadId = `test:${flowId ?? "static"}:${sessionId}`;
    const config = { configurable: { thread_id: threadId } };

    // mesmo comando de reinício do chat real (src/core/chat.ts) — sem isso,
    // #sair vira só mais uma resposta pro nó de pergunta atual no teste.
    if (message && message.trim().toLowerCase() === COMANDO_REINICIAR) {
      await checkpointer.deleteThread(threadId).catch((err) =>
        console.error("[test-chat] falha ao reiniciar thread de teste:", err)
      );
      return {
        messages: [{ role: "ai", content: "Conversa reiniciada. 🔄 Quando quiser, é só mandar uma mensagem que começamos de novo." }],
        done: true,
        dadosColetados: {},
      };
    }

    // carrega o flow específico (ou o estático se omitido)
    let graph = graphEstatico as ReturnType<typeof graphDoFlow>;
    if (flowId) {
      const flow = await db.flow.findUnique({ where: { id: flowId } });
      if (!flow) return reply.code(404).send({ erro: "fluxo não encontrado" });
      const subflows = await carregarSubflowsRecursivo(flow.nodes);
      try {
        graph = graphDoFlow(flow, subflows) as typeof graph;
      } catch (err) {
        return reply.code(422).send({ erro: `flow inválido: ${String(err)}` });
      }
    }

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
