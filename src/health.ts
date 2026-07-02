import { prisma } from "./db.js";

// Verificações de saúde para o endpoint /health e o aviso periódico de token.
// O token de teste do WhatsApp expira a cada ~24h; detectar cedo evita "demo
// quebrada" silenciosa (o envio falha com 401/403 só quando alguém escreve).

import { env } from "./env.js";
const GRAPH = env.waGraphUrl();
const API = "v23.0";

export async function verificarDb(): Promise<boolean> {
  if (!prisma) return true; // sem DATABASE_URL (dev) não é erro
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// true = token válido; false = inválido/expirado; null = não configurado
export async function verificarTokenWhatsApp(): Promise<boolean | null> {
  const token = env.waAccessToken();
  const phoneId = env.waPhoneNumberId();
  if (!token || !phoneId) return null;
  try {
    const res = await fetch(`${GRAPH}/${API}/${phoneId}?fields=id`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Aviso nos logs quando o token está morto (chamado no boot + periodicamente).
export async function avisarSeTokenMorto(): Promise<void> {
  const ok = await verificarTokenWhatsApp();
  if (ok === false) {
    console.error("[health] ⚠️ TOKEN WHATSAPP INVÁLIDO/EXPIRADO — envios vão falhar. Gerar novo token na Meta.");
  }
}
