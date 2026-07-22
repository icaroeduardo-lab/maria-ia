import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { gatewayVerdeGet } from "../../core/gateway-verde.js";

// Rotas de Assistido (cidadão) usadas PELO FLUXO — sem JWT, como os mocks.
// O nó `api` do builder faz POST com body = dadosColetados (que contém o cpf).
// Respostas no mesmo formato dos mocks antigos p/ as condições continuarem valendo.

const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

// Shape crua do Gateway Verde (GET /api/assistido/{cpf}) — issue #108.
interface AssistidoVerdeRaw {
  dados?: {
    nome?: string;
    email?: string;
    enderecoDetalhado?: {
      logradouro?: string;
      numero?: string;
      bairro?: string;
      municipio?: string;
      uf?: string;
      cep?: string;
    };
    telefonesAssistido?: { numeroTelefone?: string }[];
  };
}

// Consulta o cadastro real no Verde; mapeia pro mesmo shape do model
// Assistido local, pra `dadosPublicos()` continuar funcionando igual.
// null = não encontrado/gateway fora — quem chama cai pro fallback local.
async function consultarAssistidoVerde(cpf: string): Promise<Record<string, unknown> | null> {
  const resp = await gatewayVerdeGet<AssistidoVerdeRaw>(`/api/assistido/${cpf}`);
  const d = resp?.dados;
  if (!d?.nome) return null;
  const end = d.enderecoDetalhado ?? {};
  return {
    cpf,
    nome: d.nome,
    dataNascimento: null,
    nomeMae: null,
    situacao: "regular",
    municipio: end.municipio ?? null,
    uf: end.uf ?? null,
    telefone: d.telefonesAssistido?.[0]?.numeroTelefone ?? null,
    email: d.email ?? null,
    cep: end.cep ?? null,
    bairro: end.bairro ?? null,
    logradouro: end.logradouro ?? null,
    numero: end.numero ?? null,
  };
}

// campos do Assistido que vêm de dadosColetados no cadastro/atualização
const CAMPOS = [
  "nome", "dataNascimento", "nomeMae", "situacao",
  "municipio", "uf", "telefone", "email", "cep", "bairro", "logradouro", "numero",
] as const;

function extrairCampos(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CAMPOS) {
    const v = body[c];
    if (typeof v === "string" && v.trim()) out[c] = v.trim();
  }
  return out;
}

// remove campos internos da resposta exposta ao fluxo
function dadosPublicos(a: Record<string, unknown>) {
  const { id, createdAt, updatedAt, ...resto } = a;
  void id; void createdAt; void updatedAt;
  return resto;
}

export async function assistidosFlowRoutes(app: FastifyInstance) {
  // sem banco: rotas continuam registradas (conjunto determinístico — o guard
  // do openapi depende disso), mas todas respondem 503 via preHandler
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!; // preHandler acima garante que handler não roda sem banco

  // POST /api/assistidos/consultar — { cpf } → { encontrado, situacao, dados }
  // Tenta o Gateway Verde (cadastro real) primeiro; cai pro fallback local
  // (tabela Assistido — dados de teste/seed, ou quem se cadastrou pelo bot
  // sem constar no Verde) se não encontrar ou o gateway estiver fora (#108).
  app.post("/api/assistidos/consultar", async (req) => {
    const cpf = so_digitos((req.body as { cpf?: string })?.cpf);
    if (cpf.length !== 11) {
      console.log(`[assistidos] consultar: CPF inválido "${cpf}"`);
      return { encontrado: false, situacao: "formato_invalido", dados: null };
    }

    const verde = await consultarAssistidoVerde(cpf);
    if (verde) {
      console.log(`[assistidos] consultar: CPF ${cpf} → encontrado (Verde)`);
      return { encontrado: true, situacao: "regular", dados: verde };
    }

    const a = await db.assistido.findUnique({ where: { cpf } });
    console.log(`[assistidos] consultar: CPF ${cpf} → ${a ? "encontrado (local)" : "não cadastrado"}`);
    return {
      encontrado: !!a,
      situacao: a ? a.situacao : "nao_cadastrado",
      dados: a ? dadosPublicos(a as unknown as Record<string, unknown>) : null,
    };
  });

  // POST /api/assistidos/cadastrar — { cpf, nome, ... } → { sucesso, protocolo, dados }
  app.post("/api/assistidos/cadastrar", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cpf = so_digitos(body.cpf as string);
    if (cpf.length !== 11) return reply.code(400).send({ sucesso: false, erro: "cpf inválido" });

    const campos = extrairCampos(body);
    if (!campos.nome) return reply.code(400).send({ sucesso: false, erro: "nome obrigatório" });

    const existe = await db.assistido.findUnique({ where: { cpf } });
    if (existe) {
      console.log(`[assistidos] cadastrar: CPF ${cpf} já existe`);
      return { sucesso: false, jaExiste: true, dados: dadosPublicos(existe as unknown as Record<string, unknown>) };
    }

    const a = await db.assistido.create({ data: { cpf, nome: campos.nome, ...campos } });
    const protocolo = `CAD-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;
    console.log(`[assistidos] cadastrar: CPF ${cpf} criado — ${protocolo}`);
    return { sucesso: true, protocolo, dados: dadosPublicos(a as unknown as Record<string, unknown>) };
  });

  // POST /api/casos/consultar — { cpf } → { tem_casos, casos:[...], lista }
  // casos em aberto do assistido (usado pelo fluxo após confirmar os dados)
  app.post("/api/casos/consultar", async (req) => {
    const cpf = so_digitos((req.body as { cpf?: string })?.cpf);
    const assistido = cpf.length === 11 ? await db.assistido.findUnique({ where: { cpf } }) : null;
    const casos = assistido
      ? await db.caso.findMany({ where: { assistidoId: assistido.id, status: "aberto" }, orderBy: { criadoEm: "desc" } })
      : [];
    const enxutos = casos.map((c) => ({ identificador: c.identificador, tipo: c.tipo }));
    const lista = enxutos.map((c, i) => `${i + 1}. ${c.tipo} (${c.identificador})`).join("\n");
    console.log(`[casos] consultar: CPF ${cpf} → ${casos.length} caso(s) aberto(s)`);
    return { tem_casos: casos.length > 0, casos: enxutos, lista };
  });

  // POST /api/casos/detalhe — { caso_sel, casos? } → detalhe de 1 caso
  // caso_sel pode ser o identificador completo OU o índice (1, 2, ...) da lista
  // retornada por /api/casos/consultar (mesmo padrão do /api/processos/resumo).
  app.post("/api/casos/detalhe", async (req) => {
    const body = (req.body ?? {}) as { caso_sel?: string; casos?: string };
    const sel = String(body.caso_sel ?? "").trim();

    let identificador = sel;
    try {
      const lista = JSON.parse(body.casos ?? "{}")?.casos as { identificador: string }[] | undefined;
      const idx = /^\d{1,2}$/.exec(sel);
      if (idx && lista?.[Number(sel) - 1]) identificador = lista[Number(sel) - 1].identificador;
    } catch { /* segue com sel */ }

    const caso = await db.caso.findFirst({ where: { identificador }, include: { assistido: true } });
    if (!caso) {
      console.log(`[casos] detalhe: "${sel}" não encontrado`);
      return { encontrado: false };
    }
    console.log(`[casos] detalhe: ${caso.identificador} (${caso.tipo})`);
    return {
      encontrado: true,
      identificador: caso.identificador,
      tipo: caso.tipo,
      status: caso.status,
      criadoEm: caso.criadoEm.toISOString(),
      assistido: caso.assistido.nome,
    };
  });

  // POST /api/assistidos/atualizar — { cpf, ...campos } → { sucesso, dados }
  app.post("/api/assistidos/atualizar", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cpf = so_digitos(body.cpf as string);
    if (cpf.length !== 11) return reply.code(400).send({ sucesso: false, erro: "cpf inválido" });

    const existe = await db.assistido.findUnique({ where: { cpf } });
    if (!existe) return reply.code(404).send({ sucesso: false, erro: "assistido não encontrado" });

    const campos = extrairCampos(body);
    const a = await db.assistido.update({ where: { cpf }, data: campos });
    console.log(`[assistidos] atualizar: CPF ${cpf} → campos: ${Object.keys(campos).join(", ") || "(nenhum)"}`);
    return { sucesso: true, dados: dadosPublicos(a as unknown as Record<string, unknown>) };
  });
}
