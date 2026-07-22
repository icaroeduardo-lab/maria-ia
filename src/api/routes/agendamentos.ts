import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { gatewayVerdeGet } from "../../core/gateway-verde.js";

// Rotas de Agendamento usadas PELO FLUXO — sem JWT, como casos/consultar e
// casos/detalhe (assistidos.ts). Mesmo papel de Caso, mas pra compromissos
// marcados (atendimento/audiência) em vez de processos.

const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

const fmt = (iso: Date) => iso.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

interface AgendamentoEnxuto {
  id: string;
  tipo: string;
  data: string; // DD/MM/YYYY — já vem assim do Verde; formatamos igual no fallback local
  local: string | null;
  status: string;
}

// Shape crua do Gateway Verde (GET /api/agendamentos/{cpf}) — issue #108.
interface AgendamentosVerdeRaw {
  dados?: {
    agendamentos?: {
      numeroAgendamento?: number;
      status?: string;
      dataAgendamento?: string;
      orgao?: { nome?: string };
      assunto?: { nome?: string };
    }[];
  };
}

// null = gateway fora/CPF não encontrado — quem chama cai pro fallback local.
async function consultarAgendamentosVerde(cpf: string): Promise<AgendamentoEnxuto[] | null> {
  const resp = await gatewayVerdeGet<AgendamentosVerdeRaw>(`/api/agendamentos/${cpf}`);
  const lista = resp?.dados?.agendamentos;
  if (!lista) return null;
  return lista.map((a) => ({
    id: String(a.numeroAgendamento ?? ""),
    tipo: a.assunto?.nome ?? "Atendimento",
    data: a.dataAgendamento ?? "",
    local: a.orgao?.nome ?? null,
    status: a.status ?? "aberto",
  }));
}

export async function agendamentosFlowRoutes(app: FastifyInstance) {
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!;

  // POST /api/agendamentos/consultar — { cpf } → { tem_agendamentos, agendamentos:[...], lista }
  // Tenta o Gateway Verde primeiro; cai pro fallback local (tabela
  // Agendamento — dados de teste/seed) se não encontrar ou o gateway
  // estiver fora (#108).
  app.post("/api/agendamentos/consultar", async (req) => {
    const cpf = so_digitos((req.body as { cpf?: string })?.cpf);

    let enxutos: AgendamentoEnxuto[];
    const verde = cpf.length === 11 ? await consultarAgendamentosVerde(cpf) : null;
    if (verde) {
      enxutos = verde;
      console.log(`[agendamentos] consultar (Verde): CPF ${cpf} → ${enxutos.length} agendamento(s)`);
    } else {
      const assistido = cpf.length === 11 ? await db.assistido.findUnique({ where: { cpf } }) : null;
      const agendamentos = assistido
        ? await db.agendamento.findMany({ where: { assistidoId: assistido.id, status: "aberto" }, orderBy: { data: "asc" } })
        : [];
      enxutos = agendamentos.map((a) => ({ id: a.id, tipo: a.tipo, data: fmt(a.data), local: a.local, status: a.status }));
      console.log(`[agendamentos] consultar (local): CPF ${cpf} → ${enxutos.length} agendamento(s) aberto(s)`);
    }

    const lista = enxutos.map((a, i) => `${i + 1}. ${a.tipo} — ${a.data}${a.local ? ` (${a.local})` : ""}`).join("\n");
    return { tem_agendamentos: enxutos.length > 0, agendamentos: enxutos, lista };
  });

  // POST /api/agendamentos/detalhe — { agendamento_sel, agendamentos? } → detalhe de 1 agendamento
  // agendamento_sel pode ser o id completo OU o índice (1, 2, ...) da lista
  // retornada por /api/agendamentos/consultar. Resolve direto do JSON que o
  // fluxo já carrega (mesmo padrão de índice de casos/detalhe) — não bate
  // mais no Prisma, já que agendamentos reais (Verde) não têm registro local.
  app.post("/api/agendamentos/detalhe", async (req) => {
    const body = (req.body ?? {}) as { agendamento_sel?: string; agendamentos?: string };
    const sel = String(body.agendamento_sel ?? "").trim();

    let lista: AgendamentoEnxuto[] = [];
    try {
      lista = JSON.parse(body.agendamentos ?? "{}")?.agendamentos ?? [];
    } catch { /* segue vazio */ }

    const idx = /^\d{1,2}$/.exec(sel);
    const item = idx ? lista[Number(sel) - 1] : lista.find((a) => a.id === sel);

    if (!item) {
      console.log(`[agendamentos] detalhe: "${sel}" não encontrado`);
      return { encontrado: false };
    }
    console.log(`[agendamentos] detalhe: ${item.id} (${item.tipo})`);
    return { encontrado: true, id: item.id, tipo: item.tipo, data: item.data, local: item.local, status: item.status };
  });
}
