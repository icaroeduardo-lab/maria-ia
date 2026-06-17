import "dotenv/config";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";

// Converte imagens .webp referenciadas nos fluxos (campo data.imagem) para JPEG
// e re-aponta os nós. WhatsApp não renderiza webp em mensagem de imagem.

const BUCKET = process.env.S3_BUCKET ?? "maria-ia";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const s3 = new S3Client({ region: REGION });
const prisma = new PrismaClient();

const precisaConverter = (u: unknown): u is string =>
  typeof u === "string" && /\.webp(\?|$)/i.test(u) && u.startsWith("http");

const cache = new Map<string, string>(); // url antiga → nova
async function converter(url: string): Promise<string> {
  if (cache.has(url)) return cache.get(url)!;
  const entrada = Buffer.from(await (await fetch(url)).arrayBuffer());
  const jpg = await sharp(entrada).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const key = `imagens/${randomUUID()}.jpg`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: jpg, ContentType: "image/jpeg" }));
  const nova = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  console.log(`  ${url.split("/").pop()} (${(entrada.length / 1024).toFixed(0)}KB) → ${nova.split("/").pop()} (${(jpg.length / 1024).toFixed(0)}KB)`);
  cache.set(url, nova);
  return nova;
}

const flows = await prisma.flow.findMany();
for (const flow of flows) {
  const nodes = flow.nodes as { data?: { imagem?: unknown } }[];
  let mudou = false;
  for (const n of nodes) {
    if (n.data && precisaConverter(n.data.imagem)) {
      n.data.imagem = await converter(n.data.imagem);
      mudou = true;
    }
  }
  if (mudou) {
    await prisma.flow.update({ where: { id: flow.id }, data: { nodes: nodes as object[] } });
    console.log(`✓ ${flow.name}`);
  }
}
console.log("Concluído.");
await prisma.$disconnect();
