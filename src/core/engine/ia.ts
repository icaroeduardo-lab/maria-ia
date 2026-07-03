import { createHash } from "node:crypto";
import { ChatBedrockConverse, AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { env } from "../env.js";
import type { GraphState } from "../state.js";
import type { Pergunta } from "../perguntas.js";
import { interpolar } from "./campos.js";
import { cacheGet, cacheSet } from "../cache.js";

// Lógica de IA do engine: classificação de tema (com RAG), extração antecipada
// do relato e reescrita conversacional das perguntas. Isolado do builder para
// facilitar evoluir os fluxos.

export const model = new ChatBedrockConverse({
  model: env.bedrockModelId(),
  region: env.awsRegion(),
});

export const retriever = env.bedrockKbId()
  ? new AmazonKnowledgeBaseRetriever({
      topK: 3,
      knowledgeBaseId: env.bedrockKbId()!,
      region: env.awsRegion(),
    })
  : null;

export function ultimaFalaUsuario(state: GraphState): string {
  const m = state.messages.findLast((x) => x.getType() === "human");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : ""))
    .join(" ")
    .trim();
}

// ── Classificação de tema ─────────────────────────────────────────────────────
// categoria padrão quando nada casa: "outros" se existir, senão a última
export function categoriaPadrao(opcoes: string[]): string {
  return opcoes.find((o) => o.toLowerCase() === "outros") ?? opcoes[opcoes.length - 1];
}

// Classifica um texto livre em uma das categorias. Tenta o LLM (Bedrock); se
// falhar (sem credenciais/rede), cai num matcher por palavra-chave.
export async function classificarTexto(fala: string, opcoes: string[], prompt?: string, contextoRag?: string): Promise<string> {
  if (!opcoes.length) return "";
  if (!fala.trim()) return categoriaPadrao(opcoes); // sem relato → catch-all

  try {
    const instrucao =
      (prompt ?? "Você classifica o relato de um cidadão em uma categoria de serviço jurídico.") +
      (contextoRag ? `\n\n<base_de_conhecimento>\n${contextoRag}\n</base_de_conhecimento>` : "") +
      `\n\nCategorias possíveis (responda APENAS com uma delas, exatamente como escrita): ${opcoes.join(", ")}.`;
    const res = await model.invoke([
      new SystemMessage(instrucao),
      new HumanMessage(fala),
    ]);
    const bruto = String(res.content).toLowerCase().trim();
    const achou = opcoes.find((o) => bruto.includes(o.toLowerCase()));
    if (achou) return achou;
  } catch (err) {
    console.warn("[classificar] LLM indisponível, usando fallback por palavra-chave:", String(err).slice(0, 120));
  }

  return classificarPorPalavraChave(fala, opcoes);
}

// Fallback determinístico: mapeia palavras-chave → categoria.
const PALAVRAS_CHAVE: Record<string, string[]> = {
  alimentação: ["pensão", "pensao", "alimento", "sustento", "filho não", "mesada"],
  divórcio: ["divórcio", "divorcio", "separar", "separação", "casamento", "marido", "esposa", "cônjuge", "conjuge"],
  inss: ["inss", "aposentadoria", "aposentar", "benefício", "beneficio", "auxílio", "auxilio", "doença", "doenca", "loas", "bpc"],
  trabalhista: ["trabalho", "trabalhista", "demitido", "demissão", "rescisão", "salário", "carteira", "fgts", "emprego"],
  acompanhar: ["acompanhar", "andamento", "meu processo", "meu caso", "já tenho", "ja tenho", "protocolo"],
  fora_competencia: ["criminal", "preso", "prisão", "prisao", "empresa", "consumidor"],
};

function classificarPorPalavraChave(fala: string, opcoes: string[]): string {
  const txt = fala.toLowerCase();
  for (const opt of opcoes) {
    const chaves = PALAVRAS_CHAVE[opt.toLowerCase()] ?? [opt.toLowerCase()];
    if (chaves.some((k) => txt.includes(k))) return opt;
  }
  return categoriaPadrao(opcoes); // default → "outros" (não a última, que pode ser fora_competencia)
}

// ── Extração antecipada: a IA preenche o que o usuário já disse no relato ──────
const PLACEHOLDER = /unknown|n\/a|^null$|undefined|não informado|nao informado|<.+>|^[-?.]+$/i;
const normSimNao = (v: string) => {
  const s = v.trim().toLowerCase();
  if (s === "true" || s.startsWith("s")) return "sim";
  if (s === "false" || s.startsWith("n")) return "não";
  return v;
};
const casarOpcaoGen = (p: Pergunta, v: string) => {
  const t = v.trim().toLowerCase();
  return p.opcoes?.find((o) => o.toLowerCase() === t || o.toLowerCase().includes(t) || t.includes(o.toLowerCase()));
};

// Dado o relato livre, extrai valores para as perguntas ainda não respondidas.
// Só preenche o que foi dito EXPLICITAMENTE (guards anti-alucinação).
export async function extrairDoRelato(
  relato: string,
  perguntas: Pergunta[],
  jaColetados: Record<string, unknown>
): Promise<Record<string, string>> {
  const pendentes = perguntas.filter((p) => p.texto && !(p.chave in jaColetados));
  if (!relato.trim() || !pendentes.length) return {};

  const shape: Record<string, z.ZodType> = {};
  for (const p of pendentes) {
    const desc = p.tipo === "opcoes" && p.opcoes?.length ? `${p.texto} (opções: ${p.opcoes.join(", ")})` : p.texto;
    shape[p.chave] = z.string().nullish().describe(desc);
  }

  try {
    const system = `Você extrai dados do relato de um cidadão (Defensoria Pública do RJ).
- Extraia APENAS o que foi dito EXPLICITAMENTE no relato. NUNCA deduza, suponha ou invente.
- Em dúvida, deixe null. Campos sim/não: só preencha se afirmado claramente, use "sim" ou "não".`;
    const out = await model.withStructuredOutput(z.object(shape)).invoke([
      new SystemMessage(system),
      new HumanMessage(`Relato: "${relato}"\n\nExtraia os dados informados (deixe null o que não foi dito).`),
    ]);

    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== "string" || !v.trim() || PLACEHOLDER.test(v.trim())) continue;
      const p = pendentes.find((x) => x.chave === k);
      if (!p) continue;
      // descarta quando o LLM ecoa o texto da própria pergunta como "valor"
      if (v.trim().toLowerCase() === p.texto.trim().toLowerCase()) continue;
      if (["true", "false"].includes(v.trim().toLowerCase()) && p.tipo !== "sim_nao") continue;
      if (p.tipo === "sim_nao") { const n = normSimNao(v); if (n === "sim" || n === "não") updates[k] = n; continue; }
      if (p.tipo === "opcoes") { const o = casarOpcaoGen(p, v); if (o) updates[k] = o; continue; }
      if (p.validar && !p.validar(v)) continue;
      updates[k] = v.trim();
    }
    if (Object.keys(updates).length) console.log(`[extrair] pré-preenchido: ${Object.keys(updates).join(", ")}`);
    return updates;
  } catch (err) {
    console.warn("[extrair] falha:", String(err).slice(0, 120));
    return {};
  }
}

// ── Reescrita conversacional das perguntas ────────────────────────────────────
// Reescreve a pergunta e CACHEIA (Redis/memória): gera um POOL de variações 1×
// por (pergunta+tom+estilo), com {{nome}} como placeholder, e reusa entre
// conversas. Serve escolhendo uma variação e interpolando os dados do assistido.
const N_VARIACOES = 4;
const TTL_REESCRITA = 60 * 60 * 24 * 14; // 14 dias

const TOM_GUIA: Record<string, string> = {
  neutro: "Tom acolhedor e sereno, equilibrado.",
  empatico: "Tom mais empático e caloroso, reconhecendo o momento da pessoa.",
  "acolhedor-forte": "Tom muito acolhedor e cuidadoso — a pessoa pode estar fragilizada; passe segurança.",
};

async function gerarVariacoes(raw: string, p: Pergunta, tom: string, estilo: string): Promise<string[]> {
  const regras = [
    "Você é a Maria, da Defensoria. Reescreva a PERGUNTA de forma CALOROSA, humana e ACOLHEDORA — nunca fria/robótica.",
    "Acolha de forma GENÉRICA (ex: 'Sei que não é fácil falar disso', 'Pode ficar tranquilo(a), vou te ajudar'). NÃO cite dados específicos.",
    "É PROIBIDO começar com 'Entendo'/'Entendi' e com saudação ('Olá'/'Oi'/'Bom dia') — a conversa já começou.",
    "Onde o NOME da pessoa couber, use o placeholder {{nome}} (NÃO invente nome). Não precisa usar em toda variação.",
    "Preserve outros placeholders {{...}}, links, números e formatos (CPF, datas) exatamente.",
    "Emojis: no máximo 1, só quando combinar (difícil → 💔/🙏; criança → 🧒; documento → 📄; pensão → 💰; acolhimento → 😊).",
    "Até 3 frases curtas. Formule como pergunta DIRETA pedindo o dado. Mantenha EXATAMENTE a informação pedida.",
    TOM_GUIA[tom] ?? TOM_GUIA.neutro,
    p.tipo === "sim_nao" ? "A pergunta deve poder ser respondida com Sim ou Não." : "",
    p.tipo === "opcoes" ? "NÃO liste as opções (aparecem como botões)." : "",
    `Gere ${N_VARIACOES} variações DIFERENTES entre si.`,
  ].filter(Boolean).join("\n");

  try {
    const out = await model.withStructuredOutput(
      z.object({ variacoes: z.array(z.string()).describe(`${N_VARIACOES} reescritas diferentes da pergunta`) })
    ).invoke([
      new SystemMessage(`${estilo}\n\n${regras}`),
      new HumanMessage(`Pergunta a reescrever: "${raw}"\n\nResponda com as variações.`),
    ]);
    return (out.variacoes ?? [])
      .map((v) => String(v).replace(/\[[^\]\n]{0,40}\]/g, "").replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ").trim())
      .filter(Boolean);
  } catch (err) {
    console.warn("[conversacional] falha ao gerar variações:", String(err).slice(0, 100));
    return [];
  }
}

export async function reescreverPergunta(
  p: Pergunta,
  state: GraphState,
  estilo: string,
  opts: { tom?: string; styleVersion: string }
): Promise<string> {
  const raw = p.texto;
  const tom = opts.tom || "neutro";
  const chave = `resc:${createHash("sha1").update(`${raw}|${p.tipo}|${tom}|${opts.styleVersion}`).digest("hex").slice(0, 16)}`;

  let variacoes = await cacheGet<string[]>(chave);
  if (!variacoes?.length) {
    variacoes = await gerarVariacoes(raw, p, tom, estilo);
    if (variacoes.length) await cacheSet(chave, variacoes, TTL_REESCRITA);
  }
  // escolhe uma variação (variedade); fallback = texto cru. Interpola {{nome}} etc.
  const escolhida = variacoes.length ? variacoes[Math.floor(Math.random() * variacoes.length)] : raw;
  return interpolar(escolhida, state.dadosColetados);
}
