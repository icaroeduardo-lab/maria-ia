import type { TipoPergunta } from "../perguntas.js";

// Validação de FORMATO da resposta direta do usuário na captura dinâmica
// (builder.ts / criarCaptura) — propositalmente diferente de Pergunta.validar
// (perguntas.ts), que só vale pra valor inferido por LLM em cross-fill e
// nunca re-pergunta. Aqui, formato ruim = re-pergunta (ver LIMITE_TENTATIVAS
// em builder.ts). Só valida tipos com formato objetivo — texto/sim_nao/opcoes
// não entram (sem "formato" pra checar).

const SO_DIGITOS = (s: string) => s.replace(/\D/g, "");

const VALIDADORES: Partial<Record<TipoPergunta, (valor: string) => boolean>> = {
  cpf: (v) => SO_DIGITOS(v).length === 11,
  telefone: (v) => {
    const d = SO_DIGITOS(v).length;
    return d === 10 || d === 11;
  },
  cep: (v) => SO_DIGITOS(v).length === 8,
  data: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim())),
  // valor é o metadado JSON devolvido por POST /api/upload-documento ou pelo
  // branch de mídia do WhatsApp (src/core/channels/whatsapp.ts) — NUNCA a URL/
  // bytes do arquivo (LGPD). criarCaptura() não muda: mesmo shape-check das
  // outras tipos, só que fazendo JSON.parse antes.
  documento: (v) => {
    try {
      const o = JSON.parse(v) as { nome?: unknown; tamanho?: unknown; mimeType?: unknown };
      return typeof o.nome === "string" && o.nome.length > 0
        && typeof o.tamanho === "number" && o.tamanho > 0
        && typeof o.mimeType === "string" && o.mimeType.length > 0;
    } catch { return false; }
  },
};

/** true = formato aceito (ou tipo sem validador, ex: texto/sim_nao/opcoes). */
export function formatoValido(tipo: TipoPergunta, valor: string): boolean {
  const validar = VALIDADORES[tipo];
  return validar ? validar(valor) : true;
}

/** true = tipo tem validador de formato (builder.ts usa pra decidir se re-pergunta em captura inválida). */
export function temValidadorDeFormato(tipo: TipoPergunta): boolean {
  return tipo in VALIDADORES;
}

const MENSAGENS_ERRO: Partial<Record<TipoPergunta, string>> = {
  cpf: "Isso não parece um CPF válido — são 11 números, sem pontos ou traço. Pode conferir? 🔢",
  telefone: "Isso não parece um telefone válido — DDD + número (10 ou 11 dígitos). Pode conferir?",
  cep: "Isso não parece um CEP válido — são 8 números. Pode conferir?",
  data: "Isso não parece uma data válida — use o formato AAAA-MM-DD. Pode conferir?",
  documento: "Não recebi um arquivo válido. Envie uma foto (jpeg/png) ou PDF, até 10MB.",
};

export function mensagemErroFormato(tipo: TipoPergunta): string {
  return MENSAGENS_ERRO[tipo] ?? "Não entendi sua resposta. Pode tentar de novo?";
}
