import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import type { DadosExtraidos } from "./ocr-documento.js";

// Lê o resultado já pronto da lambda assíncrona de OCR (issue #20260214,
// src/lambdas/ocr-documento-textract/handler.ts) em vez de rodar OCR ao vivo
// via Bedrock — a rota POST /api/documentos/verificar (src/api/routes/
// documentos.ts) passou a consumir este módulo. A lambda dispara no upload
// (evento S3) e normalmente já terminou antes do fluxo chegar no node `api`
// que chama a rota (o assistido ainda responde a próxima pergunta nesse
// meio-tempo) — mas não há garantia disso, principalmente em PDF, que usa
// polling assíncrono do Textract com orçamento de até 90s dentro da lambda
// (ver POLL_ORCAMENTO_MS no handler). Por isso a leitura aqui faz
// retry/backoff com orçamento PRÓPRIO, bem menor que os 90s da lambda —
// ver ORCAMENTO_PADRAO_MS abaixo pra decisão de timeout/fallback.
//
// Módulo separado de ocr-documento.ts de propósito (um motivo por módulo):
// ocr-documento.ts cuida da COMPARAÇÃO tolerante contra o cadastro (regra de
// negócio, pura); este módulo cuida só de achar/ler/esperar o artefato do
// Textract no S3 (I/O + orquestração de espera).
//
// NÃO importa src/lambdas/ocr-documento-textract/handler.ts (nem em runtime
// nem por reexport) — a lambda é um artefato de deploy separado e
// propositalmente autocontida (ver comentário no topo dela). Os tipos/lógica
// de derivação de key abaixo são uma CÓPIA deliberada do contrato JSON que
// ela produz; se o formato do JSON ou a lógica de `keyDeSaida` mudar lá,
// tem que mudar aqui também (não tem import compartilhado por causa do
// empacotamento esbuild self-contained da lambda).

const s3 = new S3Client({ region: env.awsRegion() });

// ── Espelha o contrato JSON gravado pela lambda (ver handler.ts) ───────────

const PREFIXO_ENTRADA = "documentos/";
// Precisa bater com OUTPUT_PREFIX em infra/terraform/lambda-ocr-documento-
// textract.tf (hoje fixado em "extraidos-textract/", igual ao default do
// handler quando a env var não está setada).
const PREFIXO_SAIDA = "extraidos-textract/";

type Confianca = "alta" | "baixa" | "nao_encontrado";

interface CampoExtraidoTextract {
  valor: string | null;
  confianca: Confianca;
}

interface ResultadoTextractOk {
  documentoOrigem: { bucket: string; key: string };
  processadoEm: string;
  extraido: {
    nome: CampoExtraidoTextract;
    cpf: CampoExtraidoTextract;
    dataNascimento: CampoExtraidoTextract;
    linhasBrutas: string[];
  };
  aviso: string;
}

interface ResultadoTextractErro {
  erro: string;
}

/** Mesma lógica de derivação de `handler.ts#keyDeSaida` — replicada aqui, não reimportada (ver comentário do topo). */
export function keyResultadoTextract(sourceKey: string): string {
  const resto = sourceKey.startsWith(PREFIXO_ENTRADA) ? sourceKey.slice(PREFIXO_ENTRADA.length) : sourceKey;
  return `${PREFIXO_SAIDA}${resto}.json`;
}

// Só campos com confiança "alta" viram valor utilizável — "baixa"/
// "nao_encontrado" tratados como não-batido (pedido explícito da tarefa:
// mantém a semântica LGPD de compararComCadastro, que já só expõe booleans).
function mapearDadosConfiaveis(extraido: ResultadoTextractOk["extraido"]): DadosExtraidos {
  const confiavel = (c: CampoExtraidoTextract | undefined): string | null =>
    c?.confianca === "alta" ? (c.valor ?? null) : null;
  return {
    nome: confiavel(extraido?.nome),
    cpf: confiavel(extraido?.cpf),
    dataNascimento: confiavel(extraido?.dataNascimento),
  };
}

// ── Orquestração de espera ──────────────────────────────────────────────────
// DECISÃO DE TIMEOUT/FALLBACK (precisa validação — ver relatório da tarefa):
// o node "api" do builder (src/core/engine/builder.ts, perto da linha 356)
// aborta a chamada HTTP com AbortSignal.timeout(node.data.timeoutMs ?? 10_000)
// — 10s por padrão, configurável por node no builder visual (fora do escopo
// deste módulo, é dado de fluxo). O orçamento de espera AQUI precisa caber
// com folga dentro desse teto (senão o node aborta a conexão e o resultado
// desta função nunca chega ao chamador) — por isso o default é bem menor que
// os 90s de polling da lambda para PDF. Se um fluxo específico tende a
// processar muito PDF e quiser esperar mais, duas opções: (1) o corpo da
// requisição pode mandar `orcamentoMs` maior (a rota repassa, ver
// documentos.ts) E o node "api" correspondente ter `timeoutMs` aumentado no
// builder visual (papel do agente `fluxos`/gestor do painel); (2) aceitar o
// fallback "ainda_processando" e o fluxo perguntar de novo / tentar depois.
// Não escolhi (2) como único caminho pra não forçar redesenho de fluxo só
// pra isso — mas SEM aumentar o timeoutMs do node, aumentar orcamentoMs aqui
// não adianta (a conexão já foi abortada do lado de fora antes da resposta
// sair).
const ORCAMENTO_PADRAO_MS = env.ocrTextractOrcamentoMs();
const INTERVALO_POLL_MS = 1500;

export type StatusLeituraTextract = "pronto" | "ainda_processando" | "erro_extracao";

export interface LeituraResultadoTextract {
  status: StatusLeituraTextract;
  dados?: DadosExtraidos;
  detalheErro?: string;
}

function ehErroObjetoNaoEncontrado(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

async function tentarLerJson(
  bucket: string,
  key: string
): Promise<{ encontrado: true; corpo: unknown } | { encontrado: false }> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const texto = await obj.Body?.transformToString("utf-8");
    if (!texto) return { encontrado: false };
    return { encontrado: true, corpo: JSON.parse(texto) };
  } catch (err) {
    if (ehErroObjetoNaoEncontrado(err)) return { encontrado: false };
    throw err;
  }
}

// Exportada pra testar a interpretação do JSON (mapeamento de confiança
// incluído) sem precisar mockar S3 — mesmo racional de extrairCamposDoTexto
// em src/lambdas/ocr-documento-textract/handler.ts.
export function interpretarCorpo(corpo: unknown): LeituraResultadoTextract {
  if (corpo && typeof corpo === "object" && "erro" in corpo) {
    return { status: "erro_extracao", detalheErro: String((corpo as ResultadoTextractErro).erro) };
  }
  if (corpo && typeof corpo === "object" && "extraido" in corpo) {
    return { status: "pronto", dados: mapearDadosConfiaveis((corpo as ResultadoTextractOk).extraido) };
  }
  return { status: "erro_extracao", detalheErro: "formato de resultado inesperado" };
}

/**
 * Lê o JSON de resultado da lambda de OCR pra key do documento original,
 * com retry/backoff dentro de um orçamento de tempo (default
 * ORCAMENTO_PADRAO_MS, ver decisão de timeout no comentário acima). Nunca
 * lança por "ainda não processou" — isso vira status "ainda_processando",
 * fallback explícito pro chamador decidir o que fazer (nunca trava a
 * conversa indefinidamente).
 */
export async function lerResultadoTextractComRetry(
  bucket: string,
  sourceDocumentoKey: string,
  opts?: { orcamentoMs?: number; intervaloMs?: number }
): Promise<LeituraResultadoTextract> {
  const orcamentoMs = opts?.orcamentoMs ?? ORCAMENTO_PADRAO_MS;
  const intervaloMs = opts?.intervaloMs ?? INTERVALO_POLL_MS;
  const outputKey = keyResultadoTextract(sourceDocumentoKey);
  const inicio = Date.now();

  for (;;) {
    const tentativa = await tentarLerJson(bucket, outputKey);
    if (tentativa.encontrado) return interpretarCorpo(tentativa.corpo);
    if (Date.now() - inicio >= orcamentoMs) return { status: "ainda_processando" };
    await new Promise((resolve) => setTimeout(resolve, intervaloMs));
  }
}
