// Resolução de campos de dadosColetados (com notação de ponto + JSON aninhado)
// e interpolação de {{chave}} em textos. Puro, sem dependências de runtime.

// Ex: "resultado_cpf.encontrado" → parseia resultado_cpf como JSON e retorna .encontrado
export function resolverCampo(dados: Record<string, unknown>, caminho: string): string {
  const partes = caminho.split(".");
  let valor: unknown = dados[partes[0]];

  if (typeof valor === "string" && partes.length > 1) {
    try { valor = JSON.parse(valor); } catch { return ""; }
  }

  for (let i = 1; i < partes.length; i++) {
    if (typeof valor !== "object" || valor === null) return "";
    valor = (valor as Record<string, unknown>)[partes[i]];
  }

  if (valor === undefined || valor === null) return "";
  if (typeof valor === "boolean") return String(valor);
  if (typeof valor === "object") return JSON.stringify(valor);
  return String(valor);
}

// versão para comparação em condições: lowercase + normaliza sim/não → true/false
export function resolverCampoCondicao(dados: Record<string, unknown>, caminho: string): string {
  const v = resolverCampo(dados, caminho).toLowerCase().trim();
  if (v === "sim" || v === "s") return "true";
  if (v === "não" || v === "nao" || v === "n") return "false";
  return v;
}

// interpola {{chave}} / {{chave.sub}} com dadosColetados — ex: "CPF: {{cpf}}"
export function interpolar(txt: string, dados: Record<string, unknown>): string {
  return txt.replace(/\{\{([\w.]+)\}\}/g, (_, k) => resolverCampo(dados, k));
}
