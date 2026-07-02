// Mascaramento de PII no servidor (LGPD). O dado completo só sai via endpoint
// de revelar (auditado). Espelha o mascaramento do front, mas é a fonte de verdade.

export const mascararCpf = (v?: string | null): string => {
  const d = (v ?? "").replace(/\D/g, "");
  if (d.length !== 11) return v ?? "";
  return `•••.•••.••${d.slice(8, 9)}-••`;
};

export const mascararTelefone = (v?: string | null): string => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 2 ? `••••••${d.slice(-2)}` : v ? "••••" : "";
};

export const mascararEmail = (v?: string | null): string => {
  if (!v?.includes("@")) return v ?? "";
  const [u, dom] = v.split("@");
  const tld = dom.includes(".") ? dom.slice(dom.lastIndexOf(".")) : "";
  return `${u.slice(0, 2)}•••@•••${tld}`;
};

const mascararNomeMae = (v?: string | null): string => {
  const p = (v ?? "").trim().split(" ");
  return p.length > 1 ? `${p[0]} •••` : v ?? "";
};

// aplica máscara nos campos sensíveis de um objeto de assistido (cópia rasa)
export function mascararAssistido<T extends Record<string, unknown>>(a: T): T {
  if (!a) return a;
  const m: Record<string, unknown> = { ...a };
  if ("cpf" in m) m.cpf = mascararCpf(m.cpf as string);
  if ("telefone" in m) m.telefone = mascararTelefone(m.telefone as string);
  if ("email" in m) m.email = mascararEmail(m.email as string);
  if ("nomeMae" in m) m.nomeMae = mascararNomeMae(m.nomeMae as string);
  return m as T;
}
