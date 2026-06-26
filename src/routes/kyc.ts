import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";

// KYC de demonstração: a página /kyc.html abre a câmera do celular, "reconhece"
// o rosto e marca a identidade como confirmada para o CPF da conversa.
//
// Amarração com o fluxo do WhatsApp:
//   1. nó api → POST /api/kyc/iniciar (envia dadosColetados c/ cpf) → { url }
//   2. nó mensagem manda a {{kyc.url}}; a pessoa abre, faz a selfie
//   3. a página → POST /api/kyc/captura { token } → marca confirmado (fake)
//   4. nó api → POST /api/kyc/status (cpf) → { confirmado } → cond_kyc decide
//
// Estado em memória (suficiente para demo; some no redeploy — o KYC dura minutos).

type Estado = "pendente" | "confirmado";
const statusPorCpf = new Map<string, Estado>();
const tokenParaCpf = new Map<string, { cpf: string; criadoEm: number }>();
const TTL_MS = 30 * 60 * 1000; // tokens valem 30min

const soDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const baseUrl = () => process.env.SELF_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

function limparExpirados() {
  const agora = Date.now();
  for (const [t, v] of tokenParaCpf) if (agora - v.criadoEm > TTL_MS) tokenParaCpf.delete(t);
}

export async function kycRoutes(app: FastifyInstance) {
  // inicia o KYC: gera token amarrado ao CPF e devolve o link da página
  app.post("/api/kyc/iniciar", async (req, reply) => {
    const cpf = soDigitos((req.body as { cpf?: string })?.cpf);
    if (cpf.length !== 11) return reply.code(400).send({ erro: "cpf inválido" });
    limparExpirados();
    const token = randomUUID();
    tokenParaCpf.set(token, { cpf, criadoEm: Date.now() });
    statusPorCpf.set(cpf, "pendente");
    return { url: `${baseUrl()}/kyc.html?t=${token}`, token };
  });

  // chamado pela página após a captura — marca a identidade como confirmada
  app.post("/api/kyc/captura", async (req, reply) => {
    const token = (req.body as { token?: string })?.token ?? "";
    const reg = tokenParaCpf.get(token);
    if (!reg || Date.now() - reg.criadoEm > TTL_MS) {
      return reply.code(400).send({ ok: false, erro: "token inválido ou expirado" });
    }
    statusPorCpf.set(reg.cpf, "confirmado");
    console.log(`[kyc] identidade confirmada (cpf •••${reg.cpf.slice(-2)})`);
    return { ok: true, confirmado: true };
  });

  // o fluxo consulta se o KYC do CPF já foi confirmado
  app.post("/api/kyc/status", async (req) => {
    const cpf = soDigitos((req.body as { cpf?: string })?.cpf);
    return { confirmado: statusPorCpf.get(cpf) === "confirmado" };
  });
}
