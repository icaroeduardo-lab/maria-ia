// Resolução de campos de dadosColetados (com notação de ponto + JSON aninhado)
// e interpolação de {{chave}} em textos. Puro, sem dependências de runtime.

import {
  mascararCpf,
  mascararTelefone,
  mascararEmail,
  mascararNome,
  mascararDataNascimento,
} from "../mask.js";

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

// aplica máscara de PII (LGPD) com base no nome do último segmento do caminho
// (ex: "resultado_cpf.dados.email" → mascararEmail). Ver src/core/mask.ts.
function aplicarMascara(caminho: string, valor: string): string {
  switch (caminho.split(".").pop()) {
    case "cpf":
      return mascararCpf(valor);
    case "telefone":
      return mascararTelefone(valor);
    case "email":
      return mascararEmail(valor);
    case "nome":
    case "nomeMae":
      return mascararNome(valor);
    case "dataNascimento":
      return mascararDataNascimento(valor);
    default:
      return valor;
  }
}

// interpola {{chave}} / {{chave.sub}} com dadosColetados — ex: "CPF: {{cpf}}"
// prefixo "mask:" aplica máscara de PII no valor — ex: "{{mask:resultado_cpf.dados.email}}"
export function interpolar(txt: string, dados: Record<string, unknown>): string {
  return txt.replace(/\{\{(mask:)?([\w.]+)\}\}/g, (_, prefixoMask, caminho) => {
    const valor = resolverCampo(dados, caminho);
    return prefixoMask ? aplicarMascara(caminho, valor) : valor;
  });
}
