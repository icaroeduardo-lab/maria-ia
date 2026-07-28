import type { FastifyInstance } from "fastify";
import { gatewayVerdeGet } from "../../core/gateway-verde.js";

// Rota de Recesso vigente usada PELO FLUXO (card Coilab #20260144) — sem JWT,
// como orgao.ts/assunto.ts. Proxy real pro gateway (GET /api/recesso/vigente)
// — SUBSTITUI a "API fake" anterior (tabela Prisma `recessoVigente`, liga/
// desliga manual sem calendário real). Confirmado antes de trocar: o único
// consumidor é o fluxo-template "Recesso" (fluxoId cmrtchkqp0000jt0iiu9ogss2,
// `active:false`, NÃO plugado no fluxo ativo "MariaIA") — troca segura, zero
// fluxo em produção quebra.
//
// Shape real do gateway (testado ao vivo, DIFERENTE do RecessoDTO documentado
// no Swagger oficial — inRecessoVigente/dtInicio/dtFim/txMensagemPadrao/...):
// `{ codigo: "SEM_RECESSO_VIGENTE", dados: {} }` no caso negativo (único caso
// observável hoje, 2026-07-28 — sem recesso vigente). O caso POSITIVO não pôde
// ser reproduzido ao vivo (não há recesso ativo no momento do teste) — mapeio
// a mensagem tentando os nomes de campo do DTO oficial dentro de `dados`
// (txMensagemPadrao/txMensagemUrgencia/mensagem), com fallback genérico.
// Reconfirmar o shape positivo assim que houver uma janela de recesso real
// (ex: recesso forense de dez/jan) antes de confiar cegamente na mensagem.
//
// `status` mantém o literal exato que o fluxo-template já compara
// (SEM_RECESSO_VIGENTE / RECESSO_VIGENTE) — contrato preservado 1:1 pro
// template continuar funcionando sem alteração quando for ativado.

interface RecessoVerdeRaw {
  codigo?: string;
  dados?: {
    mensagem?: string;
    txMensagemPadrao?: string;
    txMensagemUrgencia?: string;
    txMensagemPadraoApp?: string;
    dtInicio?: string;
    dtFim?: string;
  };
}

const SEM_RECESSO = "SEM_RECESSO_VIGENTE";

export async function recessoFlowRoutes(app: FastifyInstance) {
  // GET /api/recesso/vigente — proxy GET api/recesso/vigente do gateway
  app.get("/api/recesso/vigente", async () => {
    const resp = await gatewayVerdeGet<RecessoVerdeRaw>(`/api/recesso/vigente`);
    const codigo = resp?.codigo ?? SEM_RECESSO;
    const emRecesso = codigo !== SEM_RECESSO;
    const d = resp?.dados;
    const mensagem = emRecesso
      ? (d?.txMensagemPadrao ?? d?.mensagem ?? d?.txMensagemUrgencia ?? "Estamos em recesso no momento.")
      : null;

    console.log(`[recesso] vigente: ${emRecesso ? `EM RECESSO (${codigo})` : "sem recesso"}`);
    return {
      status: emRecesso ? "RECESSO_VIGENTE" : SEM_RECESSO,
      mensagem,
    };
  });
}
