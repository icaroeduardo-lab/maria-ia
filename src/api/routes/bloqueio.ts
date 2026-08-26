import type { FastifyInstance } from "fastify";
import { gatewayVerdeGet } from "../../core/verde-direto.js";

// Rota de Bloqueio (carência) usada PELO FLUXO (card Coilab #20260148) —
// checa se o assistido tem um bloqueio ativo pra aquele assunto/órgão antes
// de confirmar agendamento/encaminhamento, pra escalonar pra atendimento
// humano em vez de deixar prosseguir.
//
// Shape real confirmado testando ao vivo contra o gateway
// (GET /api/bloqueio?idPessoa=&idAssunto=&idOrgao=), BloqueioAgendamentoDTO
// do Swagger oficial do Verde (docs/verde-original.json): { dados: { id,
// inAtivo, dataBloqueio, dataDesbloqueio } }.
//
// Caso NEGATIVO não confirmado: testado com o assistido de teste real (CPF
// 17218415717, idPessoa=2973942, idAssunto=3151 — que JÁ tem um agendamento
// real criado no card #20260146) e também com idPessoa fabricados (1, 2,
// nunca cadastrados) — em TODOS os casos o gateway devolveu inAtivo:true
// (com um `id` novo/incremental a cada combinação nova de idPessoa,
// idAssunto e idOrgao — mas idempotente pra params repetidos). Ou seja: não
// foi possível observar `inAtivo:false`/`dados` vazio em homologação com os
// dados disponíveis — pode ser peculiaridade do ambiente de homologação
// (mock sempre positivo). Tratamos ausência de `dados`/`inAtivo` como "sem
// bloqueio" por segurança (fail-open pro consultar, fail-closed só quando o
// Verde confirma bloqueio de verdade) — reconfirmar contra produção real
// antes de depender disso pra bloquear atendimento de verdade.

interface BloqueioVerdeRaw {
  dados?: {
    id?: number;
    inAtivo?: boolean;
    dataBloqueio?: string;
    dataDesbloqueio?: string;
  };
}

export async function bloqueioFlowRoutes(app: FastifyInstance) {
  // POST /api/bloqueio/verificar — { idPessoa, idAssunto, idOrgao }
  // → { tem_bloqueio, data_bloqueio, data_desbloqueio }
  app.post("/api/bloqueio/verificar", async (req) => {
    const body = (req.body ?? {}) as { idPessoa?: string | number; idAssunto?: string | number; idOrgao?: string | number };
    const idPessoa = Number(body.idPessoa);
    const idAssunto = Number(body.idAssunto);
    const idOrgao = Number(body.idOrgao);
    if (!idPessoa || !idAssunto || !idOrgao) {
      console.log(`[bloqueio] verificar: idPessoa/idAssunto/idOrgao inválidos`);
      return { tem_bloqueio: false, data_bloqueio: null, data_desbloqueio: null };
    }

    const resp = await gatewayVerdeGet<BloqueioVerdeRaw>(
      `/bloqueio?idPessoa=${idPessoa}&idAssunto=${idAssunto}&idOrgao=${idOrgao}`,
    );
    const d = resp?.dados;
    const temBloqueio = d?.inAtivo === true;

    console.log(`[bloqueio] verificar: idAssunto=${idAssunto} idOrgao=${idOrgao} → ${temBloqueio ? "BLOQUEADO" : "livre"}`);
    return {
      tem_bloqueio: temBloqueio,
      data_bloqueio: d?.dataBloqueio ?? null,
      data_desbloqueio: d?.dataDesbloqueio ?? null,
    };
  });
}
