import { ComprehendClient, DetectSentimentCommand } from "@aws-sdk/client-comprehend";
import { env } from "../env.js";

// V2 do tom: Comprehend por turno, SÓ nas perguntas livres de tema (texto, sem
// opções fechadas). V1 (extrairDoRelato) já cobre o relato inicial de graça;
// isso reavalia se o humor muda ao longo da conversa. Histerese: só escalona
// pra mais acolhedor, nunca volta pra trás (evita oscilar com uma frase neutra).

const comprehend = new ComprehendClient({ region: env.awsRegion() });

type Tom = "neutro" | "empatico" | "acolhedor-forte";
const RANK: Record<Tom, number> = { neutro: 0, empatico: 1, "acolhedor-forte": 2 };

function mapearSentimento(sentiment: string | undefined, negScore: number | undefined): Tom {
  if (sentiment === "NEGATIVE" && (negScore ?? 0) > 0.85) return "acolhedor-forte";
  if (sentiment === "NEGATIVE" || sentiment === "MIXED") return "empatico";
  return "neutro";
}

// Avalia o tom da fala e aplica histerese contra o tom atual. Retorna null se
// não deve mudar (falha, texto curto demais, ou não escalou).
export async function avaliarTom(fala: string, tomAtual: Tom | string | undefined): Promise<Tom | null> {
  const texto = fala.trim();
  if (texto.length < 8) return null; // texto curto demais p/ Comprehend avaliar com confiança

  try {
    const res = await comprehend.send(
      new DetectSentimentCommand({ Text: texto.slice(0, 5000), LanguageCode: "pt" })
    );
    const candidato = mapearSentimento(res.Sentiment, res.SentimentScore?.Negative);
    const atual = (tomAtual as Tom) in RANK ? (tomAtual as Tom) : "neutro";
    return RANK[candidato] > RANK[atual] ? candidato : null;
  } catch (err) {
    console.warn("[sentimento] Comprehend indisponível:", String(err).slice(0, 120));
    return null;
  }
}
