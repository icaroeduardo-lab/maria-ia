import type { FastifyInstance } from "fastify";
import { gatewayVerdePost } from "../../core/verde-direto.js";

// Rota de Encaminhamento usada PELO FLUXO (card Coilab #20260147, issue
// gateway#39) — "primeiro atendimento" SEM hora marcada (urgência/remoto/
// presencial). Alternativa a /api/agendamentos/agendar quando o órgão (ver
// orgao.ts) não exige vaga fixa.
//
// AVISO: POST encaminhamento/encaminhar retornou 500 direto do Verde ao
// testar em homologação (2026-07-27) — confirmado via CloudWatch que o erro
// é da API externa, não do nosso proxy (mesmo padrão do card #20260183,
// reagendar). Rota implementada e pronta; teste ao vivo do caminho de
// sucesso bloqueado até o Verde estabilizar esse endpoint.
export async function encaminhamentoFlowRoutes(app: FastifyInstance) {
  // POST /api/encaminhamento/encaminhar — { idPessoa, idOrgao, idAssunto,
  // urgencia, preferenciaAtendimento, idLocalAtendimento?, textoComplemento? }
  // → proxy POST api/encaminhamento/encaminhar.
  app.post("/api/encaminhamento/encaminhar", async (req) => {
    const body = (req.body ?? {}) as {
      idPessoa?: string | number;
      idOrgao?: string | number;
      idAssunto?: string | number;
      urgencia?: boolean | string;
      preferenciaAtendimento?: string; // "Remoto" | "Presencial"
      idLocalAtendimento?: string | number;
      textoComplemento?: string;
    };
    const payload = {
      idPessoa: Number(body.idPessoa),
      idOrgao: Number(body.idOrgao),
      idAssunto: Number(body.idAssunto),
      urgencia: body.urgencia === true || body.urgencia === "true" || body.urgencia === "sim",
      preferenciaAtendimento: body.preferenciaAtendimento ?? "Remoto",
      ...(body.idLocalAtendimento ? { idLocalAtendimento: Number(body.idLocalAtendimento) } : {}),
      fluxoEncaminhamento: "PRIMEIRO_ATENDIMENTO",
      textoComplemento: body.textoComplemento ?? "",
    };
    const resp = await gatewayVerdePost<{ dados?: { id?: number } }>("/encaminhamento/encaminhar", payload);
    console.log(`[encaminhamento] encaminhar: idPessoa=${payload.idPessoa} idOrgao=${payload.idOrgao} → ${resp.ok ? "ok" : `falha(${resp.status})`}`);
    return { sucesso: resp.ok, idEncaminhamento: resp.data?.dados?.id ?? null };
  });
}
