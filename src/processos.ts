import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { obterEstilo } from "./config.js";

// Cliente da API real de processos do PDPJ (Data Lake / PJe).
// Busca por CPF da parte (cpfCnpjParte) e por número (numeroProcesso).
// Token é temporário — vem do .env (PDPJ_API_TOKEN). Sem token/URL → desligado.

const BASE = () => (process.env.PDPJ_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = () => process.env.PDPJ_API_TOKEN ?? "";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
  temperature: 0.2,
});

// ── tipos só do que usamos da resposta crua do PDPJ ──────────────────────────
interface ParteRaw { polo?: string; nome?: string; tipoParte?: string }
interface MovimentoRaw { descricao?: string; dataHora?: string }
interface TramitacaoRaw {
  instancia?: string; ativo?: boolean;
  classe?: { descricao?: string }[];
  assunto?: { descricao?: string }[];
  orgaoJulgador?: { nome?: string };
  jurisdicao?: { nome?: string };
  ultimoMovimento?: MovimentoRaw;
  dataHoraAjuizamento?: string;
  partes?: ParteRaw[];
}
interface ProcessoRaw {
  numeroProcesso?: string;
  dataHoraUltimoMovimento?: string;
  tramitacoes?: TramitacaoRaw[];
}
interface RespostaRaw { content?: ProcessoRaw[] }

// processo já “achatado” para o fluxo (pequeno — cabe no estado sem truncar)
export interface ProcessoSimples {
  numero: string;
  classe: string;
  assunto: string;
  orgao: string;
  instancia: string;
  ativo: boolean;
  ultimoMovimento: string;
  dataUltimoMovimento: string;
  partes: string[];
}

const so = (s?: string) => (s ?? "").trim();
const fmtDataHora = (d?: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

function achatar(p: ProcessoRaw): ProcessoSimples {
  const t = p.tramitacoes?.[0] ?? {};
  return {
    numero: so(p.numeroProcesso),
    classe: so(t.classe?.[0]?.descricao),
    assunto: so(t.assunto?.[0]?.descricao) || "Não informado",
    orgao: so(t.orgaoJulgador?.nome),
    instancia: so(t.instancia),
    ativo: t.ativo !== false,
    ultimoMovimento: so(t.ultimoMovimento?.descricao),
    dataUltimoMovimento: fmtDataHora(t.ultimoMovimento?.dataHora ?? p.dataHoraUltimoMovimento),
    partes: (t.partes ?? []).map((x) => `${so(x.polo)}: ${so(x.nome)}`).filter((s) => s.length > 6),
  };
}

async function buscar(params: Record<string, string>): Promise<ProcessoRaw[]> {
  if (!BASE() || !TOKEN()) { console.warn("[pdpj] PDPJ_API_URL/TOKEN não configurados"); return []; }
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE()}/processos?${qs}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", Authorization: `Bearer ${TOKEN()}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    console.error(`[pdpj] ${res.status} em ${qs} — ${res.status === 401 ? "token expirado?" : (await res.text()).slice(0, 120)}`);
    return [];
  }
  const j = (await res.json()) as RespostaRaw;
  return j.content ?? [];
}

// Lista processos em que o CPF é parte.
export async function consultarPorCpf(cpf: string): Promise<ProcessoSimples[]> {
  const d = (cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11) return [];
  const brutos = await buscar({ cpfCnpjParte: d });
  return brutos.map(achatar).filter((p) => p.numero);
}

// Detalhe de 1 processo pelo número.
export async function consultarPorNumero(numero: string): Promise<ProcessoSimples | null> {
  const n = so(numero);
  if (!n) return null;
  const brutos = await buscar({ numeroProcesso: n });
  return brutos[0] ? achatar(brutos[0]) : null;
}

// Resumo do status do processo em linguagem simples e acolhedora (IA).
export async function resumirProcesso(p: ProcessoSimples): Promise<string> {
  const estilo = await obterEstilo();
  const dados = [
    `Número: ${p.numero}`,
    `Assunto: ${p.assunto}`,
    p.classe && `Tipo de ação: ${p.classe}`,
    p.orgao && `Onde tramita: ${p.orgao}`,
    p.instancia && `Instância: ${p.instancia}`,
    `Situação: ${p.ativo ? "em andamento" : "encerrado/baixado"}`,
    p.ultimoMovimento && `Última movimentação: ${p.ultimoMovimento}${p.dataUltimoMovimento ? ` (em ${p.dataUltimoMovimento})` : ""}`,
  ].filter(Boolean).join("\n");

  const sys = new SystemMessage(
    `${estilo}\n\nExplique para o cidadão, em linguagem MUITO simples e acolhedora, o que está acontecendo no processo dele AGORA. ` +
    `A conversa JÁ está em andamento: NÃO se apresente, NÃO cumprimente, NÃO diga seu nome — vá direto ao status. ` +
    `Foque no status atual e no que a última movimentação significa na prática. ` +
    `Não use jargão jurídico; se precisar citar um termo, explique. ` +
    `Seja breve: no máximo 3 frases curtas. Não invente prazos nem próximos passos que não estejam nos dados. ` +
    `Não repita o número do processo.`
  );
  try {
    const res = await model.invoke([sys, new HumanMessage(`Dados do processo:\n${dados}`)]);
    const txt = typeof res.content === "string" ? res.content : "";
    if (txt.trim()) return txt.trim();
  } catch (err) {
    console.error("[pdpj] resumo IA falhou:", String(err).slice(0, 120));
  }
  // fallback sem IA
  return `Seu processo sobre ${p.assunto} está ${p.ativo ? "em andamento" : "encerrado"}.` +
    (p.ultimoMovimento ? ` A última movimentação foi: ${p.ultimoMovimento}${p.dataUltimoMovimento ? ` (em ${p.dataUltimoMovimento})` : ""}.` : "");
}

// Monta a lista numerada para o assistido escolher.
export function listaNumerada(ps: ProcessoSimples[]): string {
  return ps
    .map((p, i) => `${i + 1}) ${p.numero} — ${p.assunto}${p.ativo ? "" : " (encerrado)"}`)
    .join("\n");
}
