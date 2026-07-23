import { env } from "./env.js";

// Cliente do Gateway Verde (repo GatewayConsultaApiVerde) — sem autenticação.
// Usado por assistidos.ts (consulta de cadastro) e agendamentos.ts (lista de
// agendamentos). "Não encontrado"/CPF inválido = HTTP não-2xx com corpo
// VAZIO (não é um contrato de erro rico) — tratamos qualquer !ok como "não
// achou" e quem chama decide o fallback (issue #108).

export async function gatewayVerdeGet<T>(caminho: string): Promise<T | null> {
  const base = env.gatewayVerdeUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}${caminho}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[gateway-verde] falha em ${caminho}:`, String(err).slice(0, 120));
    return null;
  }
}

// POST (reagendar/desmarcar, issue #111) — diferente do GET, sucesso pode vir
// sem corpo (204, ex: desmarcar com e-mail enviado) e quem chama precisa do
// status pra distinguir sucesso parcial (200) de completo (204). !ok = falha
// (400/422/500 do Verde) — nunca lança, quem chama decide a mensagem.
export async function gatewayVerdePost<T>(
  caminho: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const base = env.gatewayVerdeUrl();
  if (!base) return { ok: false, status: 0, data: null };
  try {
    const res = await fetch(`${base}${caminho}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    if (res.status === 204) return { ok: true, status: res.status, data: null };
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    console.warn(`[gateway-verde] falha em POST ${caminho}:`, String(err).slice(0, 120));
    return { ok: false, status: 0, data: null };
  }
}
