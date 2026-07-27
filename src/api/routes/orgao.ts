import type { FastifyInstance } from "fastify";
import { gatewayVerdeGet } from "../../core/gateway-verde.js";

// Rota de Órgão usada PELO FLUXO (cards Coilab #20260146/#20260147, issue
// gateway#39) — decide se o "primeiro atendimento" de um assunto é por
// AGENDAMENTO (hora marcada) ou ENCAMINHAMENTO (sem hora), a partir do
// campo tipoAtendimento do órgão responsável.
//
// Verde pode devolver MAIS DE UM órgão pro mesmo idPessoa/idAssunto, cada
// um com seu próprio tipoAtendimento (confirmado testando ao vivo contra
// homologação: um retornou "Encaminhamento", outro "Agendamento
// Presencial"). Simplificação adotada: usa sempre o PRIMEIRO da lista como
// "o" órgão responsável — mesmo padrão de outras rotas (ex: orgaosAssociados
// de um caso).

interface OrgaoVerdeRaw {
  dados?: {
    id?: number;
    nome?: string;
    tipoAtendimento?: string;
    enderecos?: { idLocalAtendimento?: number; logradouro?: string; municipio?: string }[];
    vagasDisponiveis?: { vagasDisponiveis?: { idIntervalo?: number; data?: string; hora?: string }[] };
  }[];
}

// tipoAtendimento vem em texto livre do Verde ("Agendamento Presencial",
// "Encaminhamento", possivelmente outras variações) — normaliza por
// substring, não por igualdade exata.
function normalizarTipo(bruto: string): "agendamento" | "encaminhamento" | "outros" {
  const t = bruto.toLowerCase();
  if (t.includes("agendamento")) return "agendamento";
  if (t.includes("encaminhamento")) return "encaminhamento";
  return "outros";
}

export async function orgaoFlowRoutes(app: FastifyInstance) {
  // POST /api/orgao/primeiro-atendimento — { idPessoa, idAssunto, complemento? }
  // → { tem_orgao, orgao_id, orgao_nome, tipo_atendimento, idLocalAtendimento,
  //     primeira_vaga_intervalo, primeira_vaga_data, primeira_vaga_hora }
  app.post("/api/orgao/primeiro-atendimento", async (req) => {
    const body = (req.body ?? {}) as { idPessoa?: string | number; idAssunto?: string | number; complemento?: string };
    const idPessoa = Number(body.idPessoa);
    const idAssunto = Number(body.idAssunto);
    if (!idPessoa || !idAssunto) {
      console.log(`[orgao] primeiro-atendimento: idPessoa/idAssunto inválidos`);
      return { tem_orgao: false };
    }

    const complemento = body.complemento ? `&complemento=${encodeURIComponent(body.complemento)}` : "";
    const resp = await gatewayVerdeGet<OrgaoVerdeRaw>(
      `/api/orgao/primeiro-atendimento?idPessoa=${idPessoa}&idAssunto=${idAssunto}${complemento}`,
    );
    const orgao = resp?.dados?.[0];
    if (!orgao?.id) {
      console.log(`[orgao] primeiro-atendimento: idAssunto=${idAssunto} → nenhum órgão encontrado`);
      return { tem_orgao: false };
    }

    const tipo = normalizarTipo(orgao.tipoAtendimento ?? "");
    const primeiraVaga = orgao.vagasDisponiveis?.vagasDisponiveis?.[0];
    const idLocalAtendimento = orgao.enderecos?.[0]?.idLocalAtendimento ?? null;

    console.log(`[orgao] primeiro-atendimento: idAssunto=${idAssunto} → órgão ${orgao.id} (${tipo})`);
    return {
      tem_orgao: true,
      orgao_id: orgao.id,
      orgao_nome: orgao.nome ?? "",
      tipo_atendimento: tipo,
      idLocalAtendimento,
      primeira_vaga_intervalo: primeiraVaga?.idIntervalo ?? null,
      primeira_vaga_data: primeiraVaga?.data ?? null,
      primeira_vaga_hora: primeiraVaga?.hora ?? null,
    };
  });
}
