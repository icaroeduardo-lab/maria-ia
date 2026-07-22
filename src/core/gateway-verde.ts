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
