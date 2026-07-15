import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { env } from "./env.js";

// Upload de documento/comprovante enviado pelo assistido (issue #74) —
// bucket PRIVADO (infra/terraform/s3-documentos.tf), nunca o bucket público
// var.s3_bucket usado por audios/uploads de imagem do builder. LGPD: nunca
// retorna URL nem bytes pro chamador — só metadado (nome/tamanho/mimeType).

export const MIME_ACEITOS = ["image/jpeg", "image/png", "application/pdf"] as const;
export type MimeAceito = (typeof MIME_ACEITOS)[number];
export const TAMANHO_MAX_BYTES = 10 * 1024 * 1024; // 10MB

const EXTENSAO_POR_MIME: Record<MimeAceito, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
};

// Assinaturas de magic bytes — ignora Content-Type declarado (spoofável no
// multipart), só confia nos bytes reais do arquivo.
const ASSINATURAS: { mime: MimeAceito; bytes: number[] }[] = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** Sniff de magic bytes — mimetype canônico, ou null se nenhuma assinatura bater. */
export function mimeReal(buffer: Buffer): MimeAceito | null {
  for (const { mime, bytes } of ASSINATURAS) {
    if (buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b)) return mime;
  }
  return null;
}

export interface DocumentoSalvo {
  nome: string;
  tamanho: number;
  mimeType: string;
}

const s3 = new S3Client({ region: env.awsRegion() });

// Grava no bucket privado de documentos. NUNCA retorna a key/URL do S3 —
// só o metadado necessário pro fluxo (dadosColetados via captura genérica).
export async function salvarDocumento(
  sessionId: string,
  buffer: Buffer,
  mimeType: MimeAceito,
  nomeOriginal: string
): Promise<DocumentoSalvo> {
  const extensao = EXTENSAO_POR_MIME[mimeType];
  const key = `documentos/${sessionId}/${randomUUID()}.${extensao}`;
  await s3.send(new PutObjectCommand({
    Bucket: env.s3BucketDocumentos(),
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return { nome: nomeOriginal, tamanho: buffer.length, mimeType };
}
