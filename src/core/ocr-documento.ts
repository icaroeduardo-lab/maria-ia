import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { env } from "./env.js";
import { mimeReal, type MimeAceito } from "./documentos.js";

// Verificação de documento por OCR (card #20260203). Fase anterior (#20260129,
// src/core/documentos.ts) já sobe foto/PDF do documento pro bucket privado
// durante o cadastro (node `pergunta` tipoPergunta:"documento") — mas só grava
// metadado (nome/tamanho/mimeType) em dadosColetados, NUNCA a key/URL do S3
// (LGPD). Este módulo faz o outro lado: acha o arquivo de volta por
// ListObjectsV2 no prefixo da sessão, roda OCR via Bedrock multimodal (Claude
// com visão — sem Textract, reaproveita a mesma infra de IA do resto do
// projeto) e compara nome/CPF extraídos com o que o assistido já digitou.
//
// LGPD: nenhuma função aqui loga nome/CPF em texto claro — só booleans de
// match saem pro chamador (rota em src/api/routes/documentos.ts).

const s3 = new S3Client({ region: env.awsRegion() });

const model = new ChatBedrockConverse({
  model: env.bedrockOcrModelId(),
  region: env.awsRegion(),
  temperature: 0,
});

export interface DocumentoBaixado {
  buffer: Buffer;
  mimeType: MimeAceito;
}

async function streamParaBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const trecho of stream) partes.push(Buffer.isBuffer(trecho) ? trecho : Buffer.from(trecho));
  return Buffer.concat(partes);
}

// Busca o documento mais recente enviado nessa sessão (pode haver mais de 1
// upload — ex: retry depois de um arquivo ilegível). null = nenhum documento
// encontrado (sessão nunca fez upload, ou já expirou pela retenção do bucket
// — infra/terraform/s3-documentos.tf, var.documentos_retencao_dias) ou o
// objeto encontrado não bate nenhuma assinatura conhecida.
export async function buscarDocumentoMaisRecente(sessionId: string): Promise<DocumentoBaixado | null> {
  const prefixo = `documentos/${sessionId}/`;
  const lista = await s3.send(
    new ListObjectsV2Command({ Bucket: env.s3BucketDocumentos(), Prefix: prefixo })
  );
  const objetos = lista.Contents ?? [];
  if (!objetos.length) return null;

  const maisRecente = objetos.reduce((a, b) =>
    (b.LastModified?.getTime() ?? 0) > (a.LastModified?.getTime() ?? 0) ? b : a
  );
  if (!maisRecente.Key) return null;

  const obj = await s3.send(new GetObjectCommand({ Bucket: env.s3BucketDocumentos(), Key: maisRecente.Key }));
  if (!obj.Body) return null;
  const buffer = await streamParaBuffer(obj.Body as AsyncIterable<Uint8Array>);

  // magic bytes, nunca confia no metadado do S3 — mesmo racional de
  // src/core/documentos.ts (Content-Type é gravado a partir do upload
  // original, mas re-sniffar aqui evita depender dessa garantia).
  const tipoReal = mimeReal(buffer);
  if (!tipoReal) return null;
  return { buffer, mimeType: tipoReal };
}

const ExtracaoSchema = z.object({
  nome: z
    .string()
    .nullish()
    .describe("Nome completo da pessoa exatamente como está impresso no documento de identidade"),
  cpf: z.string().nullish().describe("Número do CPF como está impresso no documento (com ou sem pontuação)"),
});

export interface DadosExtraidos {
  nome: string | null;
  cpf: string | null;
}

// OCR via Bedrock multimodal — sem Textract: um modelo Claude com visão já lê
// o documento e devolve nome/CPF estruturados (Zod), mesmo padrão de
// src/core/nodes/atendimento/extrator.ts. PDF vai como "file" block (Bedrock
// Converse "document"); imagem vai como "image_url" (mesmo formato do
// exemplo oficial do @langchain/aws). Suporte a PDF depende do modelo
// configurado suportar o bloco "document" do Converse — nem todo modelo
// Claude 3 suporta; ajustar BEDROCK_OCR_MODEL_ID se precisar de um modelo
// mais recente só pra esta feature.
export async function extrairDadosDocumento(doc: DocumentoBaixado): Promise<DadosExtraidos> {
  const base64 = doc.buffer.toString("base64");
  const blocoArquivo =
    doc.mimeType === "application/pdf"
      ? { type: "file" as const, source_type: "base64" as const, mime_type: doc.mimeType, data: base64 }
      : { type: "image_url" as const, image_url: { url: `data:${doc.mimeType};base64,${base64}` } };

  const resultado = await model.withStructuredOutput(ExtracaoSchema).invoke([
    new SystemMessage(
      "Você lê documentos de identidade brasileiros (RG, CNH, certidão de nascimento). Extraia SOMENTE o nome completo e o CPF exatamente como aparecem no documento. Nunca invente um valor — se não conseguir ler algum campo com segurança, devolva null nele."
    ),
    new HumanMessage({
      content: [{ type: "text", text: "Extraia o nome completo e o CPF deste documento." }, blocoArquivo],
    }),
  ]);

  return { nome: resultado.nome?.trim() || null, cpf: resultado.cpf?.trim() || null };
}

// ── Comparação tolerante ────────────────────────────────────────────────
// Nome: normaliza acento/caixa e tolera abreviação/pequeno erro de digitação
// (não exige string idêntica — nome digitado pode vir "Joao S. Pereira" e o
// documento trazer "João Silva Pereira"). CPF: exato, só dígitos.

const soDigitos = (v?: string | null): string => (v ?? "").replace(/\D/g, "");

function normalizarNome(v?: string | null): string {
  return (v ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// partículas de nome que não ajudam a diferenciar pessoa (evita falso
// negativo por causa de "de"/"da" faltando/sobrando)
const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

function tokensSignificativos(v?: string | null): string[] {
  return normalizarNome(v)
    .split(" ")
    .filter((t) => t.length > 0 && !PARTICULAS.has(t));
}

// bate exato OU um é prefixo do outro — inclui inicial isolada ("s" vs
// "silva"), que é a abreviação mais comum de nome do meio.
function tokensBatem(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// limiar 0.7: nome + sobrenome (2 tokens) exige os 2 batendo; nome composto
// (3+) tolera 1 token divergente (abreviação, erro de digitação, nome social).
export function nomesCompativeis(digitado?: string | null, extraido?: string | null): boolean {
  const nd = normalizarNome(digitado);
  const ne = normalizarNome(extraido);
  if (!nd || !ne) return false;
  if (nd === ne) return true;

  const a = tokensSignificativos(digitado);
  const b = tokensSignificativos(extraido);
  if (!a.length || !b.length) return false;

  const acertos = a.filter((ta) => b.some((tb) => tokensBatem(ta, tb))).length;
  return acertos / Math.max(a.length, b.length) >= 0.7;
}

export function cpfsCompativeis(digitado?: string | null, extraido?: string | null): boolean {
  const a = soDigitos(digitado);
  const b = soDigitos(extraido);
  return a.length === 11 && a === b;
}

export interface ResultadoVerificacao {
  match: boolean;
  detalhes: { nome_ok: boolean; cpf_ok: boolean };
}

export function compararComCadastro(
  extraido: DadosExtraidos,
  nomeCadastro?: string | null,
  cpfCadastro?: string | null
): ResultadoVerificacao {
  const nome_ok = nomesCompativeis(nomeCadastro, extraido.nome);
  const cpf_ok = cpfsCompativeis(cpfCadastro, extraido.cpf);
  return { match: nome_ok && cpf_ok, detalhes: { nome_ok, cpf_ok } };
}
