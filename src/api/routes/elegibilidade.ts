import type { FastifyInstance } from "fastify";
import { consultarAssistidoVerde, consultarCasosVerde } from "./assistidos.js";
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
          console.log(`[elegibilidade] DDD ${ddd ?? "?"} fora do RJ, sem cadastro Verde, mas cadastro local → UF RJ`);
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
}
