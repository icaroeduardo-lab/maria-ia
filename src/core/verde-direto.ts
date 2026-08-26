import { env } from "./env.js";

// Cliente HTTP DIRETO pra API real do Verde/DPERJ — substitui o gateway .NET
// (GatewayConsultaApiVerde, repo do parceiro marcellemarinsdef). Decisão
// 2026-08-26: parar de depender do gateway externo (deploy/infra de
// terceiro fora do nosso controle) e chamar o Verde direto do nosso próprio
// backend Node, usando o MESMO par JWT/X-Client-ID já testado ao vivo contra
// homologação nesta sessão.
//
// TODO TEMPORÁRIO (não é bug, não resolver agora — só não esquecer): o JWT
// usado aqui foi emitido como app "Tykhe" (app de terceiro, não da Maria) e
// EXPIRA em 2026-09-12. Antes dessa data a DPERJ/Verde precisa emitir
// credenciais próprias da Maria (client id + fluxo de rotação de token) —
// quando isso acontecer, a troca é só nas envs VERDE_JWT_TOKEN/
// VERDE_CLIENT_ID (Secrets Manager), nenhum código muda.
//
// Base real: https://homologacao.verde.rj.def.br/api/integra — único
// ambiente testado até hoje. Produção do Verde ainda não foi liberada pra
// teste pela DPERJ; a URL deve seguir o mesmo padrão trocando "homologacao"
// por produção quando/se disponibilizarem (troca via VERDE_API_URL, sem
// mudar código).
//
// Mesma interface pública de gateway-verde.ts (agora removido) DE PROPÓSITO
// — gatewayVerdeGet/gatewayVerdePost, mesma semântica de retorno
// (null/{ok,status,data}) — minimiza a mudança nos call sites das rotas
// (só troca o import; os `caminho` passados é que mudam, ver cada route
// file). Diferente do gateway .NET (sem auth), aqui SEMPRE manda
// Authorization: Bearer + X-Client-ID; sem essas duas envs configuradas,
// falha rápido (null/not-ok) sem nem tentar a rede — mesmo padrão de "base
// vazia" do client antigo.

export async function gatewayVerdeGet<T>(caminho: string): Promise<T | null> {
  const base = env.verdeApiUrl();
  const token = env.verdeJwtToken();
  const clientId = env.verdeClientId();
  if (!base || !token || !clientId) return null;
  try {
    const res = await fetch(`${base}${caminho}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-client-id": clientId,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[verde-direto] falha em ${caminho}:`, String(err).slice(0, 120));
    return null;
  }
}

// POST/PUT — mesma semântica do client antigo: !ok = falha (400/422/500 do
// Verde), nunca lança, quem chama decide a mensagem. 204 sem corpo.
export async function gatewayVerdePost<T>(
  caminho: string,
  body: unknown,
  metodo: "POST" | "PUT" = "POST",
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const base = env.verdeApiUrl();
  const token = env.verdeJwtToken();
  const clientId = env.verdeClientId();
  if (!base || !token || !clientId) return { ok: false, status: 0, data: null };
  try {
    const res = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-client-id": clientId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    if (res.status === 204) return { ok: true, status: res.status, data: null };
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    console.warn(`[verde-direto] falha em ${metodo} ${caminho}:`, String(err).slice(0, 120));
    return { ok: false, status: 0, data: null };
  }
}
