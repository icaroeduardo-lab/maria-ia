import { ChatBedrockConverse, AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { env } from "../env.js";
import type { GraphState } from "../state.js";
import type { Pergunta } from "../perguntas.js";
import { resolverCampo } from "./campos.js";

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
  // sentimento do relato → define o tom das próximas perguntas (mesma chamada, custo zero extra)
  shape._sentimento = z.enum(["neutro", "empatico", "acolhedor-forte"]).nullish()
    .describe("tom emocional do relato: 'acolhedor-forte' se a pessoa parece fragilizada/aflita/em sofrimento; 'empatico' se abalada; 'neutro' se serena");

  try {
    const system = `Você extrai dados do relato de um cidadão (Defensoria Pública do RJ).
- Extraia APENAS o que foi dito EXPLICITAMENTE no relato. NUNCA deduza, suponha ou invente.
- Em dúvida, deixe null. Campos sim/não: só preencha se afirmado claramente, use "sim" ou "não".
- Em "_sentimento", avalie o tom emocional geral do relato.`;
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
    // tom detectado (fora do loop de campos — não é uma pergunta)
    const sent = (out as Record<string, unknown>)._sentimento;
    if (typeof sent === "string" && ["neutro", "empatico", "acolhedor-forte"].includes(sent)) {
      updates.tom = sent;
    }
    if (Object.keys(updates).length) console.log(`[extrair] pré-preenchido: ${Object.keys(updates).join(", ")}`);
    return updates;
  } catch (err) {
    console.warn("[extrair] falha:", String(err).slice(0, 120));
    return {};
  }
}

// ── Reescrita conversacional das perguntas ────────────────────────────────────
// Reescreve a pergunta de forma curta, simples e acolhedora, preservando
// exatamente o que está sendo pedido. Falha → texto original.
export async function reescreverPergunta(
  textoBase: string,
  p: Pergunta,
  state: GraphState,
  estilo: string
): Promise<string> {
  try {
    const fala = ultimaFalaUsuario(state);
    // nome do assistido (cadastro existente ou novo) p/ tratamento pessoal
    const nomeCompleto = resolverCampo(state.dadosColetados, "resultado_cpf.dados.nome") || resolverCampo(state.dadosColetados, "nome");
    const primeiroNome = nomeCompleto.split(" ")[0];
    const regras = [
      "Você é a Maria, da Defensoria. Está PERGUNTANDO ao cidadão para coletar uma informação. Reescreva a PERGUNTA abaixo de forma CALOROSA, humana e ACOLHEDORA — como uma atendente atenciosa conversando, nunca fria ou robótica.",
      "Acolha a pessoa: demonstre empatia e cuidado, e passe segurança de que você está ali pra ajudar em cada passo. Pode reconhecer o sentimento/o momento dela de forma GENÉRICA e calorosa (ex: 'Sei que não é fácil falar sobre isso', 'Obrigada por confiar na gente', 'Pode ficar tranquilo(a), vou te ajudar').",
      "NÃO repita nem cite os DADOS específicos que ela acabou de informar (pra não atribuir errado, ex: confundir o nome da outra parte com o dela). Acolha o sentimento, não o dado.",
      "Varie as aberturas e o acolhimento; é PROIBIDO começar com 'Entendo'/'Entendi'.",
      primeiroNome
        ? `O nome da pessoa é ${primeiroNome} — use às vezes, com carinho (sem repetir toda vez).`
        : "Você AINDA NÃO sabe o nome da pessoa. NÃO use nome nenhum e NUNCA use placeholders como [nome], {nome} ou similares.",
      "NUNCA escreva colchetes ou chaves de placeholder no texto final (ex: [nome], {dado}). Se não tem a informação, não a mencione.",
      "Emojis: no máximo 1, só quando combinar com o sentido (situação difícil → 💔/🙏; criança → 🧒; documento → 📄; pensão → 💰; acolhimento → 😊). Não force em toda mensagem.",
      "Formule como uma pergunta DIRETA pedindo o dado ao cidadão. NUNCA inverta (não diga que a pessoa quer saber algo).",
      "Mantenha EXATAMENTE a mesma informação pedida. Não acrescente nem troque por outra pergunta.",
      "Até 3 frases curtas. NUNCA comece com saudação ('Olá', 'Oi', 'Bom dia') — a conversa já começou; vá direto ao acolhimento/pergunta.",
      "Preserve links, números, formatos (ex: CPF, datas) e termos legais exatamente como estão.",
      p.tipo === "sim_nao" ? "A pergunta deve poder ser respondida com Sim ou Não." : "",
      p.tipo === "opcoes" ? "NÃO liste as opções no texto (elas aparecem como botões)." : "",
    ].filter(Boolean).join("\n");

    const res = await model.invoke([
      new SystemMessage(`${estilo}\n\n${regras}`),
      new HumanMessage(
        `Pergunta a fazer: "${textoBase}"` +
        (primeiroNome ? `\nNome da pessoa: ${primeiroNome} (pode usar o nome com naturalidade, sem repetir toda vez)` : "") +
        (fala ? `\nÚltima fala da pessoa: "${fala}"` : "") +
        `\n\nResponda só com a pergunta reescrita.`
      ),
    ]);
    // rede de segurança: remove placeholders entre colchetes que o LLM possa ter
    // deixado (ex: "[nome]") e ajeita espaços/pontuação resultantes
    const txt = String(res.content)
      .replace(/\[[^\]\n]{0,40}\]/g, "")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    return txt || textoBase;
  } catch (err) {
    console.warn("[conversacional] falha ao reescrever:", String(err).slice(0, 100));
    return textoBase;
  }
}
