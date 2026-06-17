import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { mascararCpf, mascararTelefone } from "../mask.js";

// Gera uma "ficha" do assistido: escreve os dados (consultados pelo CPF) por cima
// de uma imagem de prancheta e hospeda o resultado no S3. Usado pelo fluxo via
// nó api (chave=ficha) + nó mensagem com imagem {{ficha.url}}.
//
// As imagens contêm PII e são efêmeras: o bucket tem uma regra de lifecycle
// ("expira-fichas-1d") que apaga tudo sob o prefixo "fichas/" após 1 dia.
// A imagem só precisa existir durante a conversa (WhatsApp baixa a mídia no envio).

const BG_PADRAO = "https://maria-ia.s3.us-east-1.amazonaws.com/e4111b2a-27ad-48b2-be19-2b68bebeab3c.webp";
const BUCKET = process.env.S3_BUCKET ?? "maria-ia";
const REGION = process.env.AWS_REGION ?? "us-east-1";

const s3 = new S3Client({ region: REGION });
const escapar = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// "1985-03-22" → "22/03/1985"; outros formatos passam intactos
const fmtData = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? `${m[3]}/${m[2]}/${m[1]}` : d; };

// extrai os dados do assistido do corpo (resultado_cpf.dados ou campos diretos)
function extrairDados(body: Record<string, unknown>): Record<string, string> {
  let dados: Record<string, unknown> = body;
  const rc = body.resultado_cpf;
  if (typeof rc === "string") { try { dados = (JSON.parse(rc) as { dados?: object }).dados ?? body; } catch { /* usa body */ } }
  else if (rc && typeof rc === "object") dados = (rc as { dados?: object }).dados ?? body;
  const g = (k: string) => (typeof dados[k] === "string" ? (dados[k] as string) : typeof body[k] === "string" ? (body[k] as string) : "");
  // CPF e telefone mascarados na imagem (PII em imagem pública/efêmera).
  // A pessoa confirma pela identidade (nome/nascimento/mãe) + final mascarado.
  return {
    nome: g("nome"),
    cpf: mascararCpf(g("cpf") || String(body.cpf ?? "")),
    dataNascimento: fmtData(g("dataNascimento")),
    nomeMae: g("nomeMae"),
    municipio: [g("municipio"), g("uf")].filter(Boolean).join(" / "),
    telefone: mascararTelefone(g("telefone")),
  };
}

// cache do fundo em memória: evita rebaixar do S3 a cada ficha
const bgCache = new Map<string, Buffer>();
async function fundo(url: string): Promise<Buffer> {
  const hit = bgCache.get(url);
  if (hit) return hit;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  bgCache.set(url, buf);
  return buf;
}

async function gerarFicha(body: Record<string, unknown>): Promise<Buffer> {
  const bgUrl = (typeof body.ficha_bg === "string" && body.ficha_bg) || BG_PADRAO;
  const bgOriginal = await fundo(bgUrl);
  // redimensiona o fundo ANTES de compor (texto fica nítido, arquivo fica leve)
  const orig = await sharp(bgOriginal).metadata();
  const larguraAlvo = Math.min(orig.width ?? 1080, 820);
  const bg = await sharp(bgOriginal).resize({ width: larguraAlvo, withoutEnlargement: true }).toBuffer();
  const meta = await sharp(bg).metadata();
  const W = meta.width ?? 820;
  const H = meta.height ?? 1093;

  const d = extrairDados(body);
  const linhas: [string, string][] = [
    ["Nome", d.nome],
    ["CPF", d.cpf],
    ["Nascimento", d.dataNascimento],
    ["Mãe", d.nomeMae],
    ["Município", d.municipio],
    ["Telefone", d.telefone],
  ].filter(([, v]) => v) as [string, string][];

  const x0 = Math.round(W * 0.23);
  const y0 = Math.round(H * 0.40);
  const passo = Math.round(H * 0.055);
  const fLabel = Math.round(H * 0.019);
  const fValor = Math.round(H * 0.026);

  const tituloY = Math.round(H * 0.32);
  const textos = linhas
    .map(([k, v], i) => {
      const y = y0 + i * passo;
      return (
        `<text x="${x0}" y="${y}" font-family="Arial, sans-serif" font-size="${fLabel}" fill="#3f7a5a">${escapar(k)}</text>` +
        `<text x="${x0}" y="${y + fValor + 4}" font-family="Arial, sans-serif" font-size="${fValor}" font-weight="bold" fill="#14532d">${escapar(v)}</text>`
      );
    })
    .join("");

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${x0}" y="${tituloY}" font-family="Arial, sans-serif" font-size="${Math.round(H * 0.03)}" font-weight="bold" fill="#14532d">DADOS DO ASSISTIDO</text>
    ${textos}
  </svg>`;

  // JPEG comprimido: ~10x menor que PNG → carrega rápido em conexão lenta.
  return sharp(bg)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

export async function fichaRoutes(app: FastifyInstance) {
  // POST /api/ficha — body = dadosColetados → { url } (imagem composta no S3)
  app.post("/api/ficha", async (req, reply) => {
    try {
      const jpg = await gerarFicha((req.body ?? {}) as Record<string, unknown>);
      const key = `fichas/${randomUUID()}.jpg`;
      try {
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: jpg, ContentType: "image/jpeg" }));
        const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
        console.log(`[ficha] gerada (${(jpg.length / 1024).toFixed(0)}KB) → ${url}`);
        return { url };
      } catch (errS3) {
        // sem S3 → devolve data URI (funciona no chat web; WhatsApp exige URL)
        console.warn("[ficha] S3 falhou, usando data URI:", String(errS3).slice(0, 120));
        return { url: `data:image/jpeg;base64,${jpg.toString("base64")}` };
      }
    } catch (err) {
      console.error("[ficha] erro:", err);
      return reply.code(500).send({ erro: String(err) });
    }
  });
}
