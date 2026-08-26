import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { mascararRg } from "../../core/mask.js";
import { gatewayVerdePost } from "../../core/verde-direto.js";

// Rotas de Pessoa Presa (apenado) usadas PELO FLUXO — sem JWT, como os mocks
// e como assistidos.ts. O nó `api` do builder faz GET com a URL já
// interpolada ({{chave}} vira query string) — todo dado de entrada chega via
// querystring, nunca body (builder.ts não envia body em métodos GET) — por
// isso estas rotas continuam GET mesmo repassando pro Verde via POST por baixo.
//
// consultar-rg (2026-08-26): trocado de mock local (tabela Postgres de teste)
// pra Verde real (POST /integra/apenado, verde-direto.ts) — motivo original
// da migração pra chamada direta ao Verde. Mesmo padrão "Verde primeiro,
// fallback local" já usado em assistidos.ts/agendamentos.ts: sem credencial
// configurada (dev/teste) ou sem resposta do Verde, cai pra tabela
// `pessoaPresa` (dados de teste/seed) — mantém a suíte determinística.
// As demais rotas (consultar-processo/casos/orgao-responsavel*) CONTINUAM
// mock local — fora do escopo desta migração (fluxo simplificado 2026-08-26
// não usa mais os campos que elas exporiam, ver nota de pp_msg_assunto_identificado
// no fluxo "Pessoa Presa (protótipo IA)").
//
// Contrato combinado com os nós hoje cadastrados no fluxo "Pessoa Presa"
// (fluxoId cmrnz07ti007blc0j5givi327, node api_apenado): só
// dados_apenado.nome é lido hoje (mensagem de confirmação de nome) — os
// demais campos ficam expostos pra uso futuro/compat com versões anteriores
// do fluxo.

interface OrgaoResponsavel {
  nome: string;
  telefone: string;
  endereco: string;
}

// Shape real de POST /integra/apenado (docs/verde-original.json →
// ApenadoResponseDTO/ApenadoDTO) — "dados" ausente/vazio = RG não encontrado.
interface ApenadoVerdeRaw {
  codigo?: string;
  mensagem?: string;
  dados?: {
    idSeap?: number;
    nome?: string;
    cpf?: string;
    regime?: string;
    situacao?: string;
    tipoPreso?: string;
    idPessoa?: number;
  };
}

interface ApenadoFlat {
  encontrado: true;
  situacao: string;
  nome: string;
  tipoPreso: string;
  regime: string;
  idPessoa: number | string;
  idSeap: number | string;
}

// null = Verde sem credencial/fora do ar/RG não encontrado — quem chama cai
// pro fallback local (tabela pessoaPresa).
async function consultarApenadoVerde(rg: string): Promise<ApenadoFlat | null> {
  const resp = await gatewayVerdePost<ApenadoVerdeRaw>("/apenado", { rg });
  const d = resp.data?.dados;
  if (!resp.ok || !d?.nome) return null;
  return {
    encontrado: true,
    situacao: d.situacao ?? "",
    nome: d.nome,
    tipoPreso: d.tipoPreso ?? "",
    regime: d.regime ?? "",
    idPessoa: d.idPessoa ?? "",
    idSeap: d.idSeap ?? "",
  };
}

const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

export async function pessoaPresaFlowRoutes(app: FastifyInstance) {
  // sem banco: rotas continuam registradas (conjunto determinístico — o guard
  // do openapi depende disso), mas todas respondem 503 via preHandler
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!; // preHandler acima garante que handler não roda sem banco

  // GET /api/pessoa-presa/consultar-rg?rg=... — dados do apenado. Verde
  // primeiro (POST /integra/apenado); cai pro fallback local (tabela
  // pessoaPresa — dados de teste/seed) se não encontrar ou o Verde estiver
  // fora/sem credencial (mesmo padrão de assistidos.ts). Resposta FLAT (sem
  // aninhar em "dados") pra bater com {{dados_apenado.nome}} já configurado
  // no fluxo.
  const VAZIO = { encontrado: false, situacao: "nao_encontrado", nome: "", tipoPreso: "", regime: "", idPessoa: "", idSeap: "" };
  app.get("/api/pessoa-presa/consultar-rg", async (req) => {
    const rg = so_digitos((req.query as { rg?: string })?.rg);
    if (!rg) {
      console.log("[pessoa-presa] consultar-rg: RG vazio/inválido");
      return VAZIO;
    }

    const verde = await consultarApenadoVerde(rg);
    if (verde) {
      console.log(`[pessoa-presa] consultar-rg: RG ${mascararRg(rg)} → encontrado (Verde)`);
      return verde;
    }

    const p = await db.pessoaPresa.findUnique({ where: { rg } });
    console.log(`[pessoa-presa] consultar-rg: RG ${mascararRg(rg)} → ${p ? "encontrado (local)" : "não cadastrado"}`);
    if (!p) return VAZIO;
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
