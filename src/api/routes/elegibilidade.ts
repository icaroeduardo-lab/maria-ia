import type { FastifyInstance } from "fastify";
import { consultarAssistidoVerde, consultarCasosVerde } from "./assistidos.js";
import { consultarAgendamentosVerde } from "./agendamentos.js";
import { prisma } from "../../core/db.js";

// Gate de elegibilidade por área de atuação da DPERJ (issue Coilab #20260134):
// atendimento é só pra residentes do RJ ou quem tem processo em trâmite no RJ.
// Checagem em camadas — só pede pro assistido responder quando não sobra
// alternativa verificável:
//   1. DDD do telefone (WhatsApp) é do RJ (21/22/24) → ok, sem checar mais nada.
//   2. DDD fora do RJ, mas CPF já cadastrado no Verde → usa a UF real de lá.
//   3. Sem UF pelo Verde → confere o fallback local (tabela Assistido — mesmo
//      cadastro que /api/assistidos/consultar já usa como fallback quando o
//      Verde falha/não acha; issue #138: elegibilidade não sabia desse
//      cadastro e perguntava de novo mesmo com uf="RJ" já salvo aí).
//   4. Ainda sem UF → checa se tem caso/processo aberto no Verde (só existe
//      caso lá se for da DPERJ, ou seja, já prova RJ).
//   5. Nada disso resolveu → devolve "perguntar" pro fluxo perguntar direto.
const DDD_RJ = new Set(["21", "22", "24"]);

// telefone_whatsapp vem cru do wa_id (formato E.164 sem +, ex "5521999990000").
// DDI 55 + DDD (2 dígitos) + número. Sem DDI (número de teste/local, <12
// dígitos) tenta ler os 2 primeiros dígitos direto como DDD.
function extrairDdd(telefone: string): string | null {
  const digitos = telefone.replace(/\D/g, "");
  if (digitos.length >= 12 && digitos.startsWith("55")) return digitos.slice(2, 4);
  if (digitos.length >= 10) return digitos.slice(0, 2);
  return null;
}

export async function elegibilidadeFlowRoutes(app: FastifyInstance) {
  // POST /api/elegibilidade/verificar { telefone_whatsapp?, cpf? } → { decisao }
  // decisao: "ok" (segue o atendimento normal) | "perguntar" (fluxo precisa
  // perguntar residência/processo direto, não tem como verificar sozinho).
  app.post("/api/elegibilidade/verificar", async (req) => {
    const body = (req.body ?? {}) as { telefone_whatsapp?: string; cpf?: string };
    const telefone = (body.telefone_whatsapp ?? "").trim();
    const cpf = (body.cpf ?? "").replace(/\D/g, "");

    const ddd = telefone ? extrairDdd(telefone) : null;
    if (ddd && DDD_RJ.has(ddd)) {
      console.log(`[elegibilidade] DDD ${ddd} → RJ (direto)`);
      return { decisao: "ok" };
    }

    if (cpf.length === 11) {
      const assistido = await consultarAssistidoVerde(cpf);
      const uf = (assistido?.uf as string | null | undefined)?.trim().toUpperCase();
      if (uf === "RJ") {
        console.log(`[elegibilidade] DDD ${ddd ?? "?"} fora do RJ, mas cadastro Verde → UF RJ`);
        return { decisao: "ok" };
      }

      if (prisma) {
        const local = await prisma.assistido.findUnique({ where: { cpf } });
        const ufLocal = local?.uf?.trim().toUpperCase();
        if (ufLocal === "RJ") {
          console.log(
            `[elegibilidade] DDD ${ddd ?? "?"} fora do RJ, sem cadastro Verde, mas cadastro local → UF RJ`
          );
          return { decisao: "ok" };
        }
      }

      const casos = await consultarCasosVerde(cpf);
      if (casos && casos.length > 0) {
        console.log(`[elegibilidade] DDD ${ddd ?? "?"} fora do RJ, sem UF RJ, mas tem caso aberto no Verde`);
        return { decisao: "ok" };
      }
    }

    console.log(`[elegibilidade] DDD ${ddd ?? "?"} fora do RJ, sem cadastro/caso no Verde → perguntar`);
    return { decisao: "perguntar" };
  });

  // POST /api/elegibilidade/tem-caso-aberto { cpf } → { tem_caso }
  // Endpoint enxuto pro node de fluxo checar isoladamente se o assistido já
  // tem caso/processo aberto no Verde (prova residência RJ na prática) — usado
  // no novo desenho do gate (roda DEPOIS da ficha do assistido, não precisa
  // mais do DDD nem re-consultar UF, que já vêm de resultado_cpf mostrado
  // antes; card Coilab #20260197).
  app.post("/api/elegibilidade/tem-caso-aberto", async (req) => {
    const cpf = ((req.body as { cpf?: string } | null)?.cpf ?? "").replace(/\D/g, "");
    if (cpf.length !== 11) return { tem_caso: false };

    const casos = await consultarCasosVerde(cpf);
    return { tem_caso: !!(casos && casos.length > 0) };
  });

  // POST /api/elegibilidade/reside-rj-ficha { uf?, telefone? } → { reside_rj }
  // Pedido do usuário 2026-08-10: UF ou DDD já presentes na ficha do Verde
  // (resultado_cpf, já consultado antes do gate) bastam pra pular a pergunta
  // elig_pergunta_reside — só pergunta direto quando nem UF nem DDD do
  // cadastro indicam RJ. Puro (sem Verde/DB), reaproveita extrairDdd.
  app.post("/api/elegibilidade/reside-rj-ficha", async (req) => {
    const body = (req.body ?? {}) as { uf?: string; telefone?: string };
    const uf = (body.uf ?? "").trim().toUpperCase();
    if (uf === "RJ") return { reside_rj: true };

    const ddd = body.telefone ? extrairDdd(body.telefone) : null;
    return { reside_rj: !!(ddd && DDD_RJ.has(ddd)) };
  });

  // POST /api/elegibilidade/tem-pendencia-aberto { cpf } → { tem_pendencia }
  // Caso OU agendamento em aberto no Verde — qualquer um dos dois já prova
  // vínculo real com a Defensoria (RJ), sem precisar checar UF nem perguntar
  // nada. Passo 1 da hierarquia nova do gate (pedido do usuário 2026-08-04,
  // card maria-ia#20260202): pendência > processo real (PDPJ) > UF da ficha
  // > pergunta direta.
  app.post("/api/elegibilidade/tem-pendencia-aberto", async (req) => {
    const cpf = ((req.body as { cpf?: string } | null)?.cpf ?? "").replace(/\D/g, "");
    if (cpf.length !== 11) return { tem_pendencia: false };

    const [casos, agendamentos] = await Promise.all([
      consultarCasosVerde(cpf),
      consultarAgendamentosVerde(cpf),
    ]);
    const tem_pendencia = !!(casos && casos.length > 0) || !!(agendamentos && agendamentos.length > 0);
    return { tem_pendencia };
  });
}
