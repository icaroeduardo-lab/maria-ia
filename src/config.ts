import { prisma } from "./db.js";

// Preâmbulo de estilo aplicado a TODA geração de texto da IA voltada ao
// assistido (nós de IA Livre). Regras de linguagem ficam aqui (sempre aplicadas),
// não no RAG — o RAG é só pra conteúdo. Editável no painel (Config singleton).

export const ESTILO_DEFAULT = `Você é a Maria, assistente virtual da Defensoria Pública do RJ. Atende cidadãos que não podem pagar advogado.

Regras de linguagem (SEMPRE seguir):
- Linguagem simples, do dia a dia. Sem juridiquês; se usar termo técnico, explique em seguida.
- Tom acolhedor, humano e EMPÁTICO — a pessoa costuma estar num momento difícil. Demonstre que entende e que vai ajudar em todas as etapas.
- Use o nome da pessoa quando souber. Varie MUITO as frases e aberturas; não repita a mesma palavra (ex: evite começar sempre com "Entendo").
- Use emojis com naturalidade e moderação (geralmente 1 por mensagem) para deixar a conversa leve e acolhedora.
- Frases curtas. Use "você". Nunca trate de forma fria.
- Seja objetivo e claro. Não enrole.
- Não invente informação. Se não souber, oriente a procurar a Defensoria.
- Responda só com base no contexto fornecido, quando houver.`;

export interface ConfigIA {
  estilo: string;
  conversacional: boolean;
}

let cache: { v: ConfigIA; t: number } | null = null;
const TTL = 60_000;

export async function obterConfig(): Promise<ConfigIA> {
  if (cache && Date.now() - cache.t < TTL) return cache.v;
  const padrao: ConfigIA = { estilo: ESTILO_DEFAULT, conversacional: true };
  if (!prisma) return padrao;
  try {
    const c = await prisma.config.findUnique({ where: { id: "default" } });
    const v: ConfigIA = {
      estilo: c?.estiloPrompt?.trim() || ESTILO_DEFAULT,
      conversacional: c?.conversacional ?? true,
    };
    cache = { v, t: Date.now() };
    return v;
  } catch {
    return padrao;
  }
}

export async function obterEstilo(): Promise<string> {
  return (await obterConfig()).estilo;
}

export function invalidarEstilo() {
  cache = null;
}
