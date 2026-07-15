import { createHash } from "node:crypto";
import { prisma } from "./db.js";

// Preâmbulo de estilo aplicado a TODA geração de texto da IA voltada ao
// assistido (nós de IA Livre). Regras de linguagem ficam aqui (sempre aplicadas),
// não no RAG — o RAG é só pra conteúdo. Editável no painel (Config singleton).

export const ESTILO_DEFAULT = `Você é a Maria, assistente virtual da Defensoria Pública do RJ. Atende cidadãos que não podem pagar advogado.

Regras de linguagem (SEMPRE seguir):
- Linguagem simples, do dia a dia. Sem juridiquês; se usar termo técnico, explique em seguida.
- Tom acolhedor, humano e EMPÁTICO — a pessoa costuma estar num momento difícil. Demonstre que entende e que vai ajudar em todas as etapas.
- Use o nome da pessoa quando souber. Varie MUITO as frases e aberturas; não repita a mesma palavra (ex: evite começar sempre com "Entendo").
- Emojis: use com parcimônia e SÓ quando combinarem com o sentido (situação difícil → 💔/🙏; criança → 🧒; documento → 📄; acolhimento → 😊). Não use em toda mensagem.
- Frases curtas. Use "você". Nunca trate de forma fria.
- Seja objetivo e claro. Não enrole.
- Não invente informação. Se não souber, oriente a procurar a Defensoria.
- Responda só com base no contexto fornecido, quando houver.`;

export interface ConfigIA {
  estilo: string;
  conversacional: boolean;
  // Horário de funcionamento (issue #79) — aviso automático fora do expediente.
  horarioAtivo: boolean;
  diasSemana: number[]; // 0=domingo...6=sábado
  horaInicio: string; // HH:mm
  horaFim: string; // HH:mm
}

const HORARIO_PADRAO = {
  horarioAtivo: false,
  diasSemana: [1, 2, 3, 4, 5],
  horaInicio: "09:00",
  horaFim: "18:00",
};

let cache: { v: ConfigIA; t: number } | null = null;
const TTL = 60_000;

export async function obterConfig(): Promise<ConfigIA> {
  if (cache && Date.now() - cache.t < TTL) return cache.v;
  const padrao: ConfigIA = { estilo: ESTILO_DEFAULT, conversacional: true, ...HORARIO_PADRAO };
  if (!prisma) return padrao;
  try {
    const c = await prisma.config.findUnique({ where: { id: "default" } });
    const v: ConfigIA = {
      estilo: c?.estiloPrompt?.trim() || ESTILO_DEFAULT,
      conversacional: c?.conversacional ?? true,
      horarioAtivo: c?.horarioAtivo ?? HORARIO_PADRAO.horarioAtivo,
      diasSemana: c?.diasSemana?.length ? c.diasSemana : HORARIO_PADRAO.diasSemana,
      horaInicio: c?.horaInicio || HORARIO_PADRAO.horaInicio,
      horaFim: c?.horaFim || HORARIO_PADRAO.horaFim,
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

// Versão do estilo (hash curto) — entra na chave do cache de reescrita.
// Editar o estilo no painel muda o hash → invalida o cache automaticamente.
export async function styleVersion(): Promise<string> {
  return createHash("sha1").update(await obterEstilo()).digest("hex").slice(0, 8);
}

export function invalidarEstilo() {
  cache = null;
}

// ── Horário de funcionamento (issue #79) ────────────────────────────────────

const DIAS_SEMANA_ABREV = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const ABREV_PARA_NUMERO: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Extrai dia da semana (0=domingo...6=sábado) e "HH:mm" de um instante, SEMPRE
// em America/Sao_Paulo — nunca usar Date.getDay()/getHours() (timezone do
// processo, que em CI/produção pode não ser America/Sao_Paulo).
function diaEHoraEmSaoPaulo(agora: Date): { diaSemana: number; horaAtual: string } {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);

  const weekday = partes.find((p) => p.type === "weekday")?.value ?? "";
  const hora = partes.find((p) => p.type === "hour")?.value ?? "00";
  const minuto = partes.find((p) => p.type === "minute")?.value ?? "00";

  return {
    diaSemana: ABREV_PARA_NUMERO[weekday] ?? 0,
    horaAtual: `${hora}:${minuto}`,
  };
}

// true quando a conversa começa fora do expediente configurado. Feature
// desligada (horarioAtivo=false) NUNCA dispara, independente da hora.
// "está no expediente" = dia em diasSemana E hora dentro de [horaInicio,horaFim);
// foraDeExpediente é a negação: dia fora de diasSemana OU hora fora do intervalo.
export async function foraDeExpediente(agora: Date = new Date()): Promise<boolean> {
  const config = await obterConfig();
  if (!config.horarioAtivo) return false;

  const { diaSemana, horaAtual } = diaEHoraEmSaoPaulo(agora);
  if (!config.diasSemana.includes(diaSemana)) return true;

  return horaAtual < config.horaInicio || horaAtual >= config.horaFim;
}

// Formata os dias configurados em pt-BR: intervalo contíguo vira "seg a sex";
// senão lista ("seg, qua e sex"). Bom senso, não precisa ser sofisticado.
export function formatarDiasSemana(dias: number[]): string {
  const ordenados = [...new Set(dias)].sort((a, b) => a - b);
  if (ordenados.length === 0) return "";
  if (ordenados.length === 1) return DIAS_SEMANA_ABREV[ordenados[0]];

  const contiguo = ordenados.every((d, i) => i === 0 || d === ordenados[i - 1] + 1);
  if (contiguo) {
    return `${DIAS_SEMANA_ABREV[ordenados[0]]} a ${DIAS_SEMANA_ABREV[ordenados[ordenados.length - 1]]}`;
  }

  const nomes = ordenados.map((d) => DIAS_SEMANA_ABREV[d]);
  return `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

// Mensagem de aviso exibida na saudação quando a conversa começa fora do
// expediente (não bloqueia o fluxo, é só um aviso extra).
export function mensagemHorarioFuncionamento(config: ConfigIA): string {
  const dias = formatarDiasSemana(config.diasSemana);
  return (
    `Nosso horário de atendimento é ${dias}, das ${config.horaInicio} às ${config.horaFim}. ` +
    "Fora desse período, sua mensagem já foi recebida e será respondida no próximo expediente."
  );
}
