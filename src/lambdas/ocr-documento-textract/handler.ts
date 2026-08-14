import {
  DetectDocumentTextCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
  type Block,
} from "@aws-sdk/client-textract";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { S3Event, S3EventRecord, S3Handler } from "aws-lambda";

// Lambda disparada por evento de upload no bucket S3 de documentos do
// assistido (aws_s3_bucket.documentos, infra/terraform/s3-documentos.tf,
// prefixo `documentos/`) — roda AWS Textract pra extrair o TEXTO BRUTO de
// qualquer documento enviado (imagem ou PDF, qualquer tipo — não só doc de
// identidade) e aplica extração por regex/heurística por cima pra achar
// CPF, data de nascimento e nome. Grava o resultado em JSON no mesmo
// bucket, prefixo `extraidos-textract/`. Só extração por enquanto — nada é
// persistido em banco/Prisma aqui.
//
// HISTÓRICO DA DECISÃO (pivô de abordagem, não é a primeira versão desta
// lambda): a primeira versão usava `AnalyzeID`, a API do Textract dedicada
// a documento de identidade (devolve campos já tipados: FIRST_NAME,
// DATE_OF_BIRTH etc). Só que `AnalyzeID` cobre oficialmente só passaporte/
// driver-license americano (ver src/core/ocr-documento-textract.ts, issue
// #194 — teste ao vivo real 2026-08-13 mostrou o AnalyzeID confundindo a
// sigla do órgão emissor com sobrenome numa CNH brasileira, e sem achar
// CPF, porque não existe campo dedicado a CPF no schema). O usuário corrigiu
// a direção: não quer ficar preso a NENHUMA API específica de documento de
// identidade nem a um tipo de documento — quer extração de texto genérica
// (`DetectDocumentText`), que funciona em qualquer imagem/PDF, com
// CPF/nome/data de nascimento resolvidos por regex/heurística por cima do
// texto. Troca o problema "API não suporta documento brasileiro" pelo
// problema "heurística pode ter falso positivo/negativo" — por isso todo
// campo extraído carrega um nível de confiança, e o resultado sempre inclui
// um `aviso` explicando a limitação.
//
// Módulo autocontido de propósito (só SDK da AWS + tipos de evento Lambda):
// não importa nem estende src/core/ocr-documento.ts (pipeline principal de
// verificação de documento via Bedrock multimodal, é o que as rotas em
// src/api/routes/documentos.ts realmente usam) nem
// src/core/ocr-documento-textract.ts (protótipo AnalyzeID da issue #194,
// mantido só como registro histórico). É um artefato deployado
// separadamente (ver infra/terraform/lambda-ocr-documento-textract.tf).

const s3 = new S3Client({});
const textract = new TextractClient({});

const PREFIXO_ENTRADA = "documentos/";
const PREFIXO_SAIDA = process.env.OUTPUT_PREFIX ?? "extraidos-textract/";

// Bytes (síncrono) só aceita imagem — limite documentado da API. PDF nunca
// passa por aqui: vai pelo fluxo assíncrono abaixo (suporta multi-página e
// arquivo maior).
const TAMANHO_MAX_SINCRONO = 5 * 1024 * 1024;
// Teto de sanidade pro caminho assíncrono (bem acima do limite de upload de
// 10MB que o app já aplica em src/core/documentos.ts — só protege contra
// objeto corrompido/gigante ir pro Textract à toa).
const TAMANHO_MAX_ASSINCRONO = 25 * 1024 * 1024;

// Orçamento de polling do job assíncrono — precisa caber dentro do timeout
// da lambda (infra/terraform/lambda-ocr-documento-textract.tf, hoje 120s),
// com folga pro resto do handler (download, upload do resultado).
const POLL_INTERVALO_MS = 2000;
const POLL_ORCAMENTO_MS = 90_000;

// ── Sniff de magic bytes (auto-contido, não importa src/core/documentos.ts) ──

type MimeSuportado = "application/pdf" | "image/jpeg" | "image/png";

const ASSINATURAS: { mime: MimeSuportado; bytes: number[] }[] = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
];

function sniffMime(buffer: Buffer): MimeSuportado | null {
  for (const { mime, bytes } of ASSINATURAS) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) return mime;
  }
  return null;
}

// ── Máscaras mínimas só pra log (LGPD — nunca PII em claro em log/stdout) ────

const mascararCpfLog = (v: string | null): string => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length === 11 ? `•••.•••.••${d.slice(8, 9)}-••` : "(vazio)";
};

const mascararNomeLog = (v: string | null): string =>
  v
    ? v
        .trim()
        .split(/\s+/)
        .map((p) => `${p[0]}•••`)
        .join(" ")
    : "(vazio)";

// ── Extração por regex/heurística sobre texto bruto (pura, sem chamada AWS) ─
// Testável isoladamente — mesmo racional de test/*.test.ts do repo.

type Confianca = "alta" | "baixa" | "nao_encontrado";

interface CampoExtraido {
  valor: string | null;
  confianca: Confianca;
}

export interface DadosExtraidosTexto {
  nome: CampoExtraido;
  cpf: CampoExtraido;
  dataNascimento: CampoExtraido;
  linhasBrutas: string[];
}

// formatado (###.###.###-##) primeiro — alta confiança, praticamente
// inequívoco. Sem formatação, cai pra 11 dígitos seguidos isolados (não
// colados a outros dígitos) — baixa confiança, pode ser telefone/RG/outro
// número de 11 dígitos que não é CPF.
const REGEX_CPF_FORMATADO = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
const REGEX_CPF_CRU = /(?<!\d)\d{11}(?!\d)/;
const REGEX_DATA = /\b\d{2}\/\d{2}\/\d{4}\b/;
const REGEX_LABEL_NASCIMENTO = /nascim/i;
// aceita numeração de campo opcional antes de "nome" (achado ao vivo em
// produção: foto de CNH real, o rótulo veio "2e1 NOME E SOBRENOME" — "2e1"
// é "2º" degradado pelo OCR) e a variação "nome e sobrenome" da CNH, além
// de "nome completo".
const REGEX_LABEL_NOME = /^\s*(?:\d[^\s]{0,3}\s+)?nome(?:\s+e\s+sobrenome|\s+completo)?\s*[:-]?\s*(.*)$/i;
// linha só de maiúsculas/acentos, 2+ palavras, tamanho plausível de nome —
// candidata em ambos: fallback fraco (sem rótulo) e busca nas linhas
// seguintes ao rótulo (sem valor na própria linha).
const REGEX_LINHA_NOME_PROVAVEL = /^[A-ZÀ-Ÿ\s]{5,60}$/;
// quantas linhas olhar depois do rótulo de nome quando ele não traz o valor
// na própria linha — cobre layout em colunas, onde o Textract pode ler o
// rótulo de OUTRO campo (coluna vizinha) antes do nome de verdade.
const JANELA_BUSCA_NOME = 3;

// linha curta com numeração de campo no início: "1ª", "2e1" (OCR degradado
// de "2º"), "3.", "4a" etc — nunca é candidata a nome, só ruído de outro
// rótulo intercalado.
const REGEX_NUMERACAO_CAMPO = /^\d[^\s]{0,3}\s/;
// rótulos de outros campos comuns em CNH/RG que podem aparecer entre o
// rótulo de nome e o nome de verdade, por causa de layout em colunas.
const REGEX_ROTULOS_OUTRO_CAMPO =
  /habilita[cç][aã]o|categoria|nascimento|naturalidade|filia[cç][aã]o|identidade|registro|permiss[aã]o|validade|emiss[aã]o|observa[cç][oõ]es?|assinatura|^cpf\b|^local\b|^uf\b/i;

function pareceRotuloDeOutroCampo(linha: string): boolean {
  const t = linha.trim();
  if (!t) return true; // linha vazia nunca é candidata — trata como "pula"
  return REGEX_NUMERACAO_CAMPO.test(t) || REGEX_ROTULOS_OUTRO_CAMPO.test(t);
}

// boilerplate de cabeçalho/rodapé de documento oficial — nunca vira
// candidato de nome, nem em confiança baixa (achado ao vivo em produção:
// foto de CNH real sem rótulo "nome" legível, o fallback fraco escolheu
// "REPUBLICA FEDERATIVA DO BRASIL" em vez do nome verdadeiro).
const REGEX_BOILERPLATE_DOCUMENTO =
  /rep[uú]blica\s+federativa\s+do\s+brasil|minist[eé]rio|secretaria\s+(nacional|de\s+estado)|carteira\s+nacional\s+de\s+habilita[cç][aã]o|v[aá]lida?\s+em\s+todo\s+o\s+territ[oó]rio|departamento\s+(nacional|estadual)|detran/i;

function ehBoilerplate(linha: string): boolean {
  return REGEX_BOILERPLATE_DOCUMENTO.test(linha.trim());
}

function candidataANomeForte(linha: string): boolean {
  const t = linha.trim();
  if (!t || pareceRotuloDeOutroCampo(t) || ehBoilerplate(t)) return false;
  if (!REGEX_LINHA_NOME_PROVAVEL.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length >= 2;
}

function extrairCpf(linhas: string[]): CampoExtraido {
  const texto = linhas.join("\n");
  const formatado = texto.match(REGEX_CPF_FORMATADO);
  if (formatado) return { valor: formatado[0], confianca: "alta" };
  const cru = texto.match(REGEX_CPF_CRU);
  if (cru) return { valor: cru[0], confianca: "baixa" };
  return { valor: null, confianca: "nao_encontrado" };
}

function extrairDataNascimento(linhas: string[]): CampoExtraido {
  const idxLabel = linhas.findIndex((l) => REGEX_LABEL_NASCIMENTO.test(l));
  if (idxLabel >= 0) {
    for (const candidata of [linhas[idxLabel], linhas[idxLabel + 1] ?? ""]) {
      const m = candidata.match(REGEX_DATA);
      if (m) return { valor: m[0], confianca: "alta" };
    }
  }
  const qualquer = linhas.join("\n").match(REGEX_DATA);
  if (qualquer) return { valor: qualquer[0], confianca: "baixa" };
  return { valor: null, confianca: "nao_encontrado" };
}

function extrairNome(linhas: string[]): CampoExtraido {
  for (let i = 0; i < linhas.length; i++) {
    const m = linhas[i].match(REGEX_LABEL_NOME);
    if (!m) continue;

    const valorMesmaLinha = m[1].trim();
    if (valorMesmaLinha.length >= 3) return { valor: valorMesmaLinha, confianca: "alta" };

    // rótulo sozinho (ou capturou vazio) — procura o valor nas próximas
    // linhas, pulando o que parecer rótulo de OUTRO campo (layout em
    // colunas pode intercalar campos fora de ordem na leitura do Textract).
    for (let j = i + 1; j <= i + JANELA_BUSCA_NOME && j < linhas.length; j++) {
      if (candidataANomeForte(linhas[j])) return { valor: linhas[j].trim(), confianca: "alta" };
    }
  }

  const fraca = linhas.find((l) => candidataANomeForte(l));
  if (fraca) return { valor: fraca.trim(), confianca: "baixa" };
  return { valor: null, confianca: "nao_encontrado" };
}

export function extrairCamposDoTexto(linhas: string[]): DadosExtraidosTexto {
  return {
    nome: extrairNome(linhas),
    cpf: extrairCpf(linhas),
    dataNascimento: extrairDataNascimento(linhas),
    linhasBrutas: linhas,
  };
}

function montarAviso(extraido: DadosExtraidosTexto): string {
  return (
    "Extração heurística por regex sobre texto bruto do Textract (DetectDocumentText) — " +
    "NÃO é leitura de campo estruturado de documento de identidade (ver histórico da decisão " +
    "no topo de src/lambdas/ocr-documento-textract/handler.ts). " +
    `Confiança: nome=${extraido.nome.confianca}, cpf=${extraido.cpf.confianca}, ` +
    `dataNascimento=${extraido.dataNascimento.confianca}. ` +
    "'baixa' = heurística fraca (ex.: sequência crua de 11 dígitos pode ser telefone/RG, não " +
    "necessariamente CPF; nome sem rótulo reconhecido pode ser qualquer linha em maiúsculas do " +
    "documento). Validar manualmente antes de usar, principalmente em confiança 'baixa'."
  );
}

// ── Handler ───────────────────────────────────────────────────────────────

async function streamParaBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const trecho of stream) partes.push(Buffer.isBuffer(trecho) ? trecho : Buffer.from(trecho));
  return Buffer.concat(partes);
}

function keyDeSaida(sourceKey: string): string {
  const resto = sourceKey.startsWith(PREFIXO_ENTRADA) ? sourceKey.slice(PREFIXO_ENTRADA.length) : sourceKey;
  return `${PREFIXO_SAIDA}${resto}.json`;
}

async function gravarResultado(bucket: string, sourceKey: string, corpo: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyDeSaida(sourceKey),
      Body: JSON.stringify(corpo, null, 2),
      ContentType: "application/json",
    })
  );
}

function linhasDosBlocos(blocks: Block[]): string[] {
  return blocks
    .filter((b) => b.BlockType === "LINE")
    .map((b) => b.Text?.trim() ?? "")
    .filter(Boolean);
}

// PDF (potencialmente multi-página): fluxo assíncrono oficial da AWS pra
// esse caso — StartDocumentTextDetection recebe a referência S3 direto
// (não precisa reenviar bytes), GetDocumentTextDetection é feito por
// polling até SUCCEEDED/FAILED ou estourar o orçamento de tempo. Sem
// NotificationChannel/SNS (evita infra extra) — aceitável pro volume/porte
// deste MVP; se o volume crescer, trocar polling por notificação SNS.
async function extrairBlocosAssincrono(bucket: string, key: string): Promise<Block[] | null> {
  const start = await textract.send(
    new StartDocumentTextDetectionCommand({ DocumentLocation: { S3Object: { Bucket: bucket, Name: key } } })
  );
  if (!start.JobId) throw new Error("StartDocumentTextDetection não devolveu JobId");

  const inicio = Date.now();
  while (Date.now() - inicio < POLL_ORCAMENTO_MS) {
    const resp = await textract.send(new GetDocumentTextDetectionCommand({ JobId: start.JobId }));
    if (resp.JobStatus === "SUCCEEDED") {
      const blocks = [...(resp.Blocks ?? [])];
      let nextToken = resp.NextToken;
      while (nextToken) {
        const pagina = await textract.send(
          new GetDocumentTextDetectionCommand({ JobId: start.JobId, NextToken: nextToken })
        );
        blocks.push(...(pagina.Blocks ?? []));
        nextToken = pagina.NextToken;
      }
      return blocks;
    }
    if (resp.JobStatus === "FAILED") {
      throw new Error(`StartDocumentTextDetection falhou: ${resp.StatusMessage ?? "sem detalhe"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVALO_MS));
  }
  return null; // estourou o orçamento de polling
}

async function processarRegistro(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  // Defesa em profundidade — o filtro do evento S3 (Terraform) já restringe
  // prefixo/sufixo, mas nunca confiar só na config de infra.
  if (!key.startsWith(PREFIXO_ENTRADA) || key.startsWith(PREFIXO_SAIDA)) {
    console.log(`[ocr-textract] ignorado (fora do prefixo esperado) key=${key}`);
    return;
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!obj.Body) {
    await gravarResultado(bucket, key, { erro: "objeto sem corpo no S3" });
    return;
  }
  const buffer = await streamParaBuffer(obj.Body as AsyncIterable<Uint8Array>);
  const mime = sniffMime(buffer);
  if (!mime) {
    await gravarResultado(bucket, key, {
      erro: "assinatura de arquivo não reconhecida (não é PDF/JPEG/PNG)",
    });
    return;
  }

  let blocks: Block[];
  if (mime === "application/pdf") {
    if (buffer.length > TAMANHO_MAX_ASSINCRONO) {
      await gravarResultado(bucket, key, {
        erro: `PDF com ${buffer.length} bytes excede o teto de sanidade (${TAMANHO_MAX_ASSINCRONO} bytes)`,
      });
      return;
    }
    const resultado = await extrairBlocosAssincrono(bucket, key);
    if (resultado === null) {
      await gravarResultado(bucket, key, {
        erro: "processamento assíncrono do Textract não concluiu dentro do orçamento de tempo desta lambda — reprocessar",
      });
      return;
    }
    blocks = resultado;
  } else {
    if (buffer.length > TAMANHO_MAX_SINCRONO) {
      await gravarResultado(bucket, key, {
        erro: `imagem com ${buffer.length} bytes excede o limite síncrono do Textract (${TAMANHO_MAX_SINCRONO} bytes)`,
      });
      return;
    }
    const resp = await textract.send(new DetectDocumentTextCommand({ Document: { Bytes: buffer } }));
    blocks = resp.Blocks ?? [];
  }

  const linhas = linhasDosBlocos(blocks);
  const extraido = extrairCamposDoTexto(linhas);

  console.log(
    `[ocr-textract] extraído key=${key} nome=${mascararNomeLog(extraido.nome.valor)} ` +
      `(${extraido.nome.confianca}) cpf=${mascararCpfLog(extraido.cpf.valor)} (${extraido.cpf.confianca}) ` +
      `temDataNascimento=${extraido.dataNascimento.valor !== null} (${extraido.dataNascimento.confianca})`
  );

  await gravarResultado(bucket, key, {
    documentoOrigem: { bucket, key },
    processadoEm: new Date().toISOString(),
    extraido,
    aviso: montarAviso(extraido),
  });
}

export const handler: S3Handler = async (event: S3Event) => {
  for (const record of event.Records) {
    try {
      await processarRegistro(record);
    } catch (err) {
      // Deixa propagar: invocação assíncrona (S3→Lambda) tem retry
      // automático da AWS (2 tentativas) e, esgotado, cai na DLQ configurada
      // em infra/terraform/lambda-ocr-documento-textract.tf
      // (dead_letter_config) — não silenciar aqui.
      console.error(`[ocr-textract] falhou key=${record.s3.object.key} erro=${(err as Error).message}`);
      throw err;
    }
  }
};
