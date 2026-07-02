import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { obterEstilo } from "./config.js";
import { env } from "./env.js";

// Gera, no fim do atendimento, um resumo em linguagem natural + metadados
// limpos (identidade + caso do tema escolhido) — para enviar/salvar na DPERJ.

const model = new ChatBedrockConverse({
  model: env.bedrockModelId(),
  region: env.awsRegion(),
  temperature: 0.2,
});

const parseJson = (v: unknown) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const fmtCpf = (c?: string) => { const d = (c ?? "").replace(/\D/g, ""); return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : (c ?? ""); };
const fmtData = (d?: string) => {
  if (!d) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);          // YYYY-MM-DD
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(d);        // AAAAMMDD (Receita)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
};

// chaves de sistema/controle — não entram no "caso"
const SISTEMA = new Set([
  "aceita_lgpd", "cpf", "resultado_cpf", "ficha", "dados_ok", "relato", "categoria",
  "agendamento", "telefone", "email", "dados_novos", "voltar_fc", "outro_assunto",
  "retry_kyc", "retry_proc", "fez_cadastro", "voltar_cad", "processos", "resultado_upd",
  "resultado_cadastro", "resultado_kyc",
]);

export interface Metadados {
  categoria: string | null;
  lgpd_aceito: boolean;
  assistido: Record<string, string | null>;
  caso: Record<string, string>;
  relato: string;
  encaminhamento?: Record<string, unknown>;
  protocolo: string | null;
}

export function montarMetadados(dados: Record<string, unknown>): Metadados {
  const rc = parseJson(dados.resultado_cpf) as { dados?: Record<string, string> } | null;
  const id = rc?.dados ?? {};
  const ag = parseJson(dados.agendamento) as Record<string, string> | null;

  // caso = só campos coletados do tema (texto simples, fora os de sistema)
  const caso: Record<string, string> = {};
  for (const [k, v] of Object.entries(dados)) {
    if (SISTEMA.has(k)) continue;
    if (typeof v === "string" && v.trim() && !v.trim().startsWith("{")) caso[k] = v;
  }

  return {
    categoria: (dados.categoria as string) ?? null,
    lgpd_aceito: dados.aceita_lgpd === "sim",
    assistido: {
      cpf: fmtCpf(dados.cpf as string),
      nome: id.nome ?? null,
      dataNascimento: fmtData(id.dataNascimento) || null,
      nomeMae: id.nomeMae ?? null,
      municipio: [id.municipio, id.uf].filter(Boolean).join(" / ") || null,
      telefone: (dados.telefone as string) || id.telefone || null,
      email: (dados.email as string) || id.email || null,
      situacao: id.situacao ?? null,
    },
    caso,
    relato: (dados.relato as string) ?? "",
    encaminhamento: ag ? { tipo: "agendamento", ...ag } : undefined,
    protocolo: ag?.agendamento_id ?? (dados.protocolo as string) ?? null,
  };
}

// Resumo em 1 parágrafo curto (linguagem da Defensoria). Fallback: template.
export async function gerarResumoTexto(m: Metadados): Promise<string> {
  const fallback = `${m.assistido.nome ?? "Assistido"} relatou: ${m.relato || "(sem relato)"}. Categoria: ${m.categoria ?? "—"}.`;
  try {
    const estilo = await obterEstilo();
    const dadosCaso = Object.entries(m.caso).map(([k, v]) => `${k}: ${v}`).join("; ");
    const res = await model.invoke([
      new SystemMessage(`${estilo}\n\nResuma o caso para o defensor (interno), em 1 parágrafo curto e objetivo. Sem saudação. Não invente nada além dos dados.`),
      new HumanMessage(`Nome: ${m.assistido.nome}\nCategoria: ${m.categoria}\nRelato: ${m.relato}\nDados do caso: ${dadosCaso || "(nenhum)"}`),
    ]);
    return String(res.content).trim() || fallback;
  } catch {
    return fallback;
  }
}
