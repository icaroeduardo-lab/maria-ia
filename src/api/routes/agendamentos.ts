import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { gatewayVerdeGet, gatewayVerdePost } from "../../core/gateway-verde.js";

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

  // POST /api/agendamentos/detalhe-rico — { idEvento } → proxy GET
  // api/agendamento/{idEvento} do gateway (issue #111). Campos extras (endereço,
  // documentos, órgão, idAssistido) que o detalhe enxuto acima não tem —
  // usado quando o assistido escolhe reagendar/desmarcar. Envelope "dados" do
  // Verde é desembrulhado (mesmo padrão de casos/agendamentos), nomes de
  // campo internos preservados.
  app.post("/api/agendamentos/detalhe-rico", async (req) => {
    const idEvento = String((req.body as { idEvento?: string | number })?.idEvento ?? "").trim();
    if (!idEvento) return { encontrado: false };

    const resp = await gatewayVerdeGet<{ dados?: Record<string, unknown> }>(`/api/agendamento/${idEvento}`);
    if (!resp?.dados) {
      console.log(`[agendamentos] detalhe-rico: ${idEvento} não encontrado`);
      return { encontrado: false };
    }
    console.log(`[agendamentos] detalhe-rico: ${idEvento} ok`);
    return { encontrado: true, ...resp.dados };
  });

  // POST /api/agendamentos/vagas — { idEvento } → proxy GET
  // api/agendamento/vagas/{idEvento} (issue #111). vagasDisponiveis real:
  // [{idIntervalo, data, hora}] (não documentado no Swagger do Verde,
  // confirmado testando ao vivo).
  app.post("/api/agendamentos/vagas", async (req) => {
    const idEvento = String((req.body as { idEvento?: string | number })?.idEvento ?? "").trim();
    if (!idEvento) return { tem_vagas: false, vagas: [], lista: "" };

    const resp = await gatewayVerdeGet<{ dados?: { vagasDisponiveis?: { idIntervalo?: number; data?: string; hora?: string }[] } }>(
      `/api/agendamento/vagas/${idEvento}`,
    );
    const vagas = resp?.dados?.vagasDisponiveis ?? [];
    const lista = vagas.map((v, i) => `${i + 1}. ${v.data} às ${v.hora}`).join("\n");
    console.log(`[agendamentos] vagas: ${idEvento} → ${vagas.length} vaga(s)`);
    return { tem_vagas: vagas.length > 0, vagas, lista };
  });

  // POST /api/agendamentos/vaga-detalhe — { vaga_sel, vagas } → resolve a
  // vaga escolhida do JSON que /vagas já retornou (mesmo padrão de índice de
  // casos/detalhe e agendamentos/detalhe — zero chamada nova ao Verde).
  app.post("/api/agendamentos/vaga-detalhe", async (req) => {
    const body = (req.body ?? {}) as { vaga_sel?: string; vagas?: string };
    const sel = String(body.vaga_sel ?? "").trim();

    let vagas: { idIntervalo?: number; data?: string; hora?: string }[] = [];
    try {
      vagas = JSON.parse(body.vagas ?? "{}")?.vagas ?? [];
    } catch { /* segue vazio */ }

    const idx = /^\d{1,2}$/.exec(sel);
    const vaga = idx ? vagas[Number(sel) - 1] : undefined;

    if (!vaga) {
      console.log(`[agendamentos] vaga-detalhe: "${sel}" não encontrada`);
      return { encontrada: false };
    }
    console.log(`[agendamentos] vaga-detalhe: idIntervalo=${vaga.idIntervalo}`);
    return { encontrada: true, idIntervalo: vaga.idIntervalo, data: vaga.data, hora: vaga.hora };
  });

  // POST /api/agendamentos/reagendar — { idAgendamento, configuracaoIntervaloAgenda, dataNova, horaNova }
  // → proxy POST api/agendamento/reagendar (issue #111). Nunca loga PII —
  // só id e sucesso/falha. dataNova vai combinada com horário
  // ("DD/MM/YYYY HH:mm") — testado contra homologação: só a data sozinha
  // dá 400 (parâmetro inválido), com horário passa da validação.
  app.post("/api/agendamentos/reagendar", async (req) => {
    const body = (req.body ?? {}) as {
      idAgendamento?: string | number;
      configuracaoIntervaloAgenda?: string | number;
      dataNova?: string;
      horaNova?: string;
    };
    const dataHora = [body.dataNova, body.horaNova].filter(Boolean).join(" ");
    const payload = {
      idAgendamento: Number(body.idAgendamento),
      configuracaoIntervaloAgenda: Number(body.configuracaoIntervaloAgenda),
      dataNova: dataHora,
    };
    const resp = await gatewayVerdePost("/api/agendamento/reagendar", payload);
    console.log(`[agendamentos] reagendar: idAgendamento=${payload.idAgendamento} → ${resp.ok ? "ok" : `falha(${resp.status})`}`);
    return { sucesso: resp.ok };
  });

  // POST /api/agendamentos/desmarcar — { idAgendamento, idPessoa } → proxy
  // POST api/agendamento/desmarcar (issue #111). 200 = desmarcado mas e-mail
  // falhou (sucesso parcial), 204 = desmarcado + e-mail enviado — ambos
  // sucesso pro Verde, expostos aqui como emailEnviado pro fluxo avisar certo.
  app.post("/api/agendamentos/desmarcar", async (req) => {
    const body = (req.body ?? {}) as { idAgendamento?: string | number; idPessoa?: string | number };
    const payload = { idAgendamento: Number(body.idAgendamento), idPessoa: Number(body.idPessoa) };
    const resp = await gatewayVerdePost("/api/agendamento/desmarcar", payload);
    console.log(`[agendamentos] desmarcar: idAgendamento=${payload.idAgendamento} → ${resp.ok ? "ok" : `falha(${resp.status})`}`);
    return { sucesso: resp.ok, emailEnviado: resp.status === 204 };
  });
}
