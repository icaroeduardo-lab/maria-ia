import { prisma } from "./db.js";

// Preâmbulo de estilo aplicado a TODA geração de texto da IA voltada ao
// assistido (nós de IA Livre). Regras de linguagem ficam aqui (sempre aplicadas),
// não no RAG — o RAG é só pra conteúdo. Editável no painel (Config singleton).

export const ESTILO_DEFAULT = `Você é a Maria, assistente virtual da Defensoria Pública do RJ. Atende cidadãos que não podem pagar advogado.

Regras de linguagem (SEMPRE seguir):
- Linguagem simples, do dia a dia. Sem juridiquês; se usar termo técnico, explique em seguida.
- Tom acolhedor, humano e respeitoso — a pessoa pode estar num momento difícil.
- Frases curtas. No máximo 2 frases por mensagem (fora perguntas).
- Use "você". Nunca trate de forma fria.
- Seja objetivo e claro. Não enrole.
- Não invente informação. Se não souber, oriente a procurar a Defensoria.
- Responda só com base no contexto fornecido, quando houver.`;

let cache: { v: string; t: number } | null = null;
const TTL = 60_000;

export async function obterEstilo(): Promise<string> {
  if (cache && Date.now() - cache.t < TTL) return cache.v;
  if (!prisma) return ESTILO_DEFAULT;
  try {
    const c = await prisma.config.findUnique({ where: { id: "default" } });
    const v = c?.estiloPrompt?.trim() || ESTILO_DEFAULT;
    cache = { v, t: Date.now() };
    return v;
  } catch {
    return ESTILO_DEFAULT;
  }
}

export function invalidarEstilo() {
  cache = null;
}
