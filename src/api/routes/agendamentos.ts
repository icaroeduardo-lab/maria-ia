import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";

// Rotas de Agendamento usadas PELO FLUXO — sem JWT, como casos/consultar e
// casos/detalhe (assistidos.ts). Mesmo papel de Caso, mas pra compromissos
// marcados (atendimento/audiência) em vez de processos.

const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

const fmt = (iso: Date) => iso.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

export async function agendamentosFlowRoutes(app: FastifyInstance) {
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!;

  // POST /api/agendamentos/consultar — { cpf } → { tem_agendamentos, agendamentos:[...], lista }
  app.post("/api/agendamentos/consultar", async (req) => {
    const cpf = so_digitos((req.body as { cpf?: string })?.cpf);
    const assistido = cpf.length === 11 ? await db.assistido.findUnique({ where: { cpf } }) : null;
    const agendamentos = assistido
      ? await db.agendamento.findMany({ where: { assistidoId: assistido.id, status: "aberto" }, orderBy: { data: "asc" } })
      : [];
    const enxutos = agendamentos.map((a) => ({ id: a.id, tipo: a.tipo, data: a.data.toISOString(), local: a.local }));
    const lista = agendamentos.map((a, i) => `${i + 1}. ${a.tipo} — ${fmt(a.data)}${a.local ? ` (${a.local})` : ""}`).join("\n");
    console.log(`[agendamentos] consultar: CPF ${cpf} → ${agendamentos.length} agendamento(s) aberto(s)`);
    return { tem_agendamentos: agendamentos.length > 0, agendamentos: enxutos, lista };
  });

  // POST /api/agendamentos/detalhe — { agendamento_sel, agendamentos? } → detalhe de 1 agendamento
  // agendamento_sel pode ser o id completo OU o índice (1, 2, ...) da lista
  // retornada por /api/agendamentos/consultar (mesmo padrão de casos/detalhe).
  app.post("/api/agendamentos/detalhe", async (req) => {
    const body = (req.body ?? {}) as { agendamento_sel?: string; agendamentos?: string };
    const sel = String(body.agendamento_sel ?? "").trim();

    let id = sel;
    try {
      const lista = JSON.parse(body.agendamentos ?? "{}")?.agendamentos as { id: string }[] | undefined;
      const idx = /^\d{1,2}$/.exec(sel);
      if (idx && lista?.[Number(sel) - 1]) id = lista[Number(sel) - 1].id;
    } catch { /* segue com sel */ }

    const agendamento = await db.agendamento.findFirst({ where: { id }, include: { assistido: true } });
    if (!agendamento) {
      console.log(`[agendamentos] detalhe: "${sel}" não encontrado`);
      return { encontrado: false };
    }
    console.log(`[agendamentos] detalhe: ${agendamento.id} (${agendamento.tipo})`);
    return {
      encontrado: true,
      id: agendamento.id,
      tipo: agendamento.tipo,
      data: agendamento.data.toISOString(),
      local: agendamento.local,
      status: agendamento.status,
      assistido: agendamento.assistido.nome,
    };
  });
}
