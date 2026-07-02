import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { processarMensagem } from "../../core/chat.js";
import { enviarWhatsApp } from "../../core/channels/whatsapp.js";
import { env } from "../../core/env.js";

// KYC de demonstração: a página /kyc.html abre a câmera do celular, "reconhece"
// o rosto e marca a identidade como confirmada. Ao confirmar, o backend RETOMA
// a conversa do WhatsApp automaticamente (a pessoa não precisa digitar nada).
//
// Fluxo:
//   1. nó api → POST /api/kyc/iniciar (dadosColetados + _sessao + _canal) → { url }
//   2. nó mensagem manda {{kyc.url}}; o fluxo PAUSA esperando a selfie
//   3. página → POST /api/kyc/captura { token } → marca confirmado + retoma o WhatsApp
//   4. a próxima mensagem do fluxo é empurrada sozinha pro WhatsApp

type Estado = "pendente" | "confirmado";
const statusPorCpf = new Map<string, Estado>();
const tokens = new Map<string, { cpf: string; sessao?: string; canal?: string; criadoEm: number }>();
const TTL_MS = 30 * 60 * 1000;

const soDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
// Link aberto pelo CELULAR do assistido → precisa ser público (PUBLIC_URL).
// Cai para SELF_URL/localhost só em dev.
const baseUrl = () => env.publicUrl();

function limparExpirados() {
  const agora = Date.now();
  for (const [t, v] of tokens) if (agora - v.criadoEm > TTL_MS) tokens.delete(t);
}

// retoma a conversa do WhatsApp após a identidade ser confirmada: injeta um
// "pronto" sintético, o fluxo avança e a próxima mensagem é enviada.
async function retomarWhatsApp(sessao: string) {
  try {
    const { newMessages } = await processarMensagem(sessao, "✅ identidade confirmada", "whatsapp");
    const numero = sessao.replace(/^wa:/, "");
    if (newMessages.length) await enviarWhatsApp(numero, newMessages);
  } catch (err) {
    console.error("[kyc] falha ao retomar WhatsApp:", err);
  }
}

export async function kycRoutes(app: FastifyInstance) {
  app.post("/api/kyc/iniciar", async (req, reply) => {
    const b = (req.body ?? {}) as { cpf?: string; _sessao?: string; _canal?: string };
    const cpf = soDigitos(b.cpf);
    if (cpf.length !== 11) return reply.code(400).send({ erro: "cpf inválido" });
    limparExpirados();
    const token = randomUUID();
    tokens.set(token, { cpf, sessao: b._sessao, canal: b._canal, criadoEm: Date.now() });
    statusPorCpf.set(cpf, "pendente");
    return { url: `${baseUrl()}/kyc.html?t=${token}`, token };
  });

  app.post("/api/kyc/captura", async (req, reply) => {
    const token = (req.body as { token?: string })?.token ?? "";
    const reg = tokens.get(token);
    if (!reg || Date.now() - reg.criadoEm > TTL_MS) {
      return reply.code(400).send({ ok: false, erro: "token inválido ou expirado" });
    }
    statusPorCpf.set(reg.cpf, "confirmado");
    console.log(`[kyc] identidade confirmada (cpf •••${reg.cpf.slice(-2)})`);
    // retoma o WhatsApp sozinho (async — não bloqueia a resposta à página)
    if (reg.canal === "whatsapp" && reg.sessao) retomarWhatsApp(reg.sessao);
    return { ok: true, confirmado: true };
  });

  // o fluxo consulta se o KYC do CPF já foi confirmado
  app.post("/api/kyc/status", async (req) => {
    const cpf = soDigitos((req.body as { cpf?: string })?.cpf);
    return { confirmado: statusPorCpf.get(cpf) === "confirmado" };
  });
}
