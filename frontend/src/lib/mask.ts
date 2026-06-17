// Mascaramento de dados sensíveis para exibição no painel (LGPD).
// Mostra parte do dado pra identificação, escondendo o resto com •.

export function mascararCpf(v?: string | null): string {
  const d = (v ?? "").replace(/\D/g, "");
  if (d.length !== 11) return v ?? "";
  return `•••.•••.${d.slice(6, 9).replace(/\d/g, "•").slice(0, 2)}${d.slice(8, 9)}-••`;
}

export function mascararTelefone(v?: string | null): string {
  const d = (v ?? "").replace(/\D/g, "");
  if (d.length < 4) return v ? "••••" : "";
  return `••••••${d.slice(-2)}`;
}

export function mascararEmail(v?: string | null): string {
  if (!v || !v.includes("@")) return v ?? "";
  const [u, dom] = v.split("@");
  const ini = u.slice(0, 2);
  const tld = dom.includes(".") ? dom.slice(dom.lastIndexOf(".")) : "";
  return `${ini}•••@•••${tld}`;
}

// aplica a máscara conforme a chave do campo
export function mascararCampo(chave: string, valor?: string | null): string {
  const k = chave.toLowerCase();
  if (k === "cpf") return mascararCpf(valor);
  if (k.includes("telefone") || k === "ddd") return mascararTelefone(valor);
  if (k.includes("email")) return mascararEmail(valor);
  if (k.includes("nomemae") || k === "nome_mae") {
    // nome da mãe: mostra só o primeiro nome
    const p = (valor ?? "").trim().split(" ");
    return p.length > 1 ? `${p[0]} •••` : (valor ?? "");
  }
  return valor ?? "";
}

// campos considerados sensíveis (recebem máscara por padrão)
export function ehSensivel(chave: string): boolean {
  const k = chave.toLowerCase();
  return k === "cpf" || k.includes("telefone") || k.includes("email") || k.includes("nomemae");
}
