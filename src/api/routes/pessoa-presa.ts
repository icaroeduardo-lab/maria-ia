import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { mascararRg } from "../../core/mask.js";

// Rotas de Pessoa Presa (apenado) usadas PELO FLUXO — sem JWT, como os mocks
// e como assistidos.ts. "API fake" provisória: substitui os 5 nós `api` do
// subfluxo "Pessoa Presa" que apontavam pra URLs inventadas (sem SEAP/apenado
// real ainda). O nó `api` do builder faz GET com a URL já interpolada
// ({{chave}} vira query string) — todo dado de entrada chega via querystring,
// nunca body (builder.ts não envia body em métodos GET).
//
// Contrato combinado com os nós hoje cadastrados no fluxo "Pessoa Presa"
// (fluxoId cmrnz07ti007blc0j5givi327, ver notas dos nós api_apenado/api_casos/
// api_orgao/api_orgao_liberto/api_processo):
//   - dados_apenado.situacao / .nome / .idPessoa / .idSeap → lidos por
//     pp_confirma_nome, cond_situacao e pelas urls de api_casos/api_orgao(_liberto)
//   - casos_pessoa_presa.status → cond_status_caso espera literalmente "ABERTO"
//   - orgao_responsavel_pp.status → cond_tem_orgao espera literalmente "encontrado"

interface OrgaoResponsavel {
  nome: string;
  telefone: string;
  endereco: string;
}

const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

export async function pessoaPresaFlowRoutes(app: FastifyInstance) {
  // sem banco: rotas continuam registradas (conjunto determinístico — o guard
  // do openapi depende disso), mas todas respondem 503 via preHandler
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!; // preHandler acima garante que handler não roda sem banco

  // GET /api/pessoa-presa/consultar-rg?rg=... — dados do apenado (mock SEAP)
  // resposta FLAT (sem aninhar em "dados") pra bater com {{dados_apenado.nome}}
  // e cond_situacao (campo: dados_apenado.situacao) já configurados no fluxo.
  app.get("/api/pessoa-presa/consultar-rg", async (req) => {
    const rg = so_digitos((req.query as { rg?: string })?.rg);
    if (!rg) {
      console.log("[pessoa-presa] consultar-rg: RG vazio/inválido");
      return { encontrado: false, situacao: "nao_encontrado", nome: "", tipoPreso: "", regime: "", idPessoa: "", idSeap: "" };
    }
    const p = await db.pessoaPresa.findUnique({ where: { rg } });
    console.log(`[pessoa-presa] consultar-rg: RG ${mascararRg(rg)} → ${p ? "encontrado" : "não cadastrado"}`);
    if (!p) return { encontrado: false, situacao: "nao_encontrado", nome: "", tipoPreso: "", regime: "", idPessoa: "", idSeap: "" };
    return {
      encontrado: true,
      situacao: p.situacao,
      nome: p.nome,
      tipoPreso: p.tipoPreso,
      regime: p.regime ?? "",
      idPessoa: p.idPessoa,
      idSeap: p.idSeap,
    };
  });

  // GET /api/pessoa-presa/consultar-processo?numero=... — origem + id do processo
  app.get("/api/pessoa-presa/consultar-processo", async (req) => {
    const numero = so_digitos((req.query as { numero?: string })?.numero);
    if (!numero) {
      console.log("[pessoa-presa] consultar-processo: número vazio/inválido");
      return { encontrado: false, numero: "", origem: "", idProcesso: "" };
    }
    const proc = await db.processoPessoaPresa.findUnique({ where: { numero } });
    console.log(`[pessoa-presa] consultar-processo: nº ${numero} → ${proc ? "encontrado" : "não cadastrado"}`);
    if (!proc) return { encontrado: false, numero, origem: "", idProcesso: "" };
    return { encontrado: true, numero: proc.numero, origem: proc.origem, idProcesso: proc.idProcesso };
  });

  // GET /api/pessoa-presa/casos?idPessoaPresa=... — casos abertos (dados_apenado.idPessoa)
  // status top-level "ABERTO" quando há caso aberto — cond_status_caso compara literal.
  app.get("/api/pessoa-presa/casos", async (req) => {
    const idPessoa = String((req.query as { idPessoaPresa?: string })?.idPessoaPresa ?? "").trim();
    const pessoa = idPessoa ? await db.pessoaPresa.findUnique({ where: { idPessoa } }) : null;
    const casos = pessoa
      ? await db.casoPessoaPresa.findMany({ where: { pessoaPresaId: pessoa.id, status: "ABERTO" }, orderBy: { criadoEm: "desc" } })
      : [];
    const enxutos = casos.map((c) => ({ identificador: c.identificador, tipo: c.tipo }));
    const lista = enxutos.map((c, i) => `${i + 1}. ${c.tipo} (${c.identificador})`).join("\n");
    console.log(`[pessoa-presa] casos: idPessoaPresa "${idPessoa || "(vazio)"}" → ${casos.length} caso(s) aberto(s)`);
    return { tem_casos: casos.length > 0, status: casos.length > 0 ? "ABERTO" : "", casos: enxutos, lista };
  });

  // GET /api/pessoa-presa/orgao-responsavel?idSeap=...&preferencia=... — órgão p/ réu PRESO
  // status "encontrado" é o valor literal que cond_tem_orgao compara.
  app.get("/api/pessoa-presa/orgao-responsavel", async (req) => {
    const idSeap = String((req.query as { idSeap?: string })?.idSeap ?? "").trim();
    const pessoa = idSeap ? await db.pessoaPresa.findUnique({ where: { idSeap } }) : null;
    const orgao = (pessoa?.orgaoPreso ?? null) as OrgaoResponsavel | null;
    console.log(`[pessoa-presa] orgao-responsavel (preso): idSeap "${idSeap || "(vazio)"}" → ${orgao ? "encontrado" : "não encontrado"}`);
    return orgao ? { status: "encontrado", orgao } : { status: "nao_encontrado", orgao: null };
  });

  // GET /api/pessoa-presa/orgao-responsavel-liberto?idSeap=... — órgão p/ réu LIBERTO
  app.get("/api/pessoa-presa/orgao-responsavel-liberto", async (req) => {
    const idSeap = String((req.query as { idSeap?: string })?.idSeap ?? "").trim();
    const pessoa = idSeap ? await db.pessoaPresa.findUnique({ where: { idSeap } }) : null;
    const orgao = (pessoa?.orgaoLiberto ?? null) as OrgaoResponsavel | null;
    console.log(`[pessoa-presa] orgao-responsavel-liberto: idSeap "${idSeap || "(vazio)"}" → ${orgao ? "encontrado" : "não encontrado"}`);
    return orgao ? { status: "encontrado", orgao } : { status: "nao_encontrado", orgao: null };
  });
}
