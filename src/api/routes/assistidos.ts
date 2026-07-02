import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";

// Rotas de Assistido (cidadão) usadas PELO FLUXO — sem JWT, como os mocks.
// O nó `api` do builder faz POST com body = dadosColetados (que contém o cpf).
// Respostas no mesmo formato dos mocks antigos p/ as condições continuarem valendo.

const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

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
  if (!prisma) {
    app.all("/api/assistidos/*", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
    return;
  }
  const db = prisma;

  // POST /api/assistidos/consultar — { cpf } → { encontrado, situacao, dados }
  app.post("/api/assistidos/consultar", async (req) => {
    const cpf = so_digitos((req.body as { cpf?: string })?.cpf);
    if (cpf.length !== 11) {
      console.log(`[assistidos] consultar: CPF inválido "${cpf}"`);
      return { encontrado: false, situacao: "formato_invalido", dados: null };
    }
    const a = await db.assistido.findUnique({ where: { cpf } });
    console.log(`[assistidos] consultar: CPF ${cpf} → ${a ? "encontrado" : "não cadastrado"}`);
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
