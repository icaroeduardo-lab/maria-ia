import { env } from "./env.js";

// Download de mídia da Graph API da Meta (WhatsApp) — 2 passos: metadata
// (id → url binária assinada) → bytes. Extraído de transcribe.ts (era função
// privada só do fluxo de áudio) para ser reusado também no upload de
// documento/imagem enviado pelo assistido (issue #74).

const GRAPH_URL = () => env.waGraphUrl();
const API_VERSION = () => env.waApiVersion();

export async function baixarMidia(mediaId: string, token: string): Promise<Buffer> {
  const metaRes = await fetch(`${GRAPH_URL()}/${API_VERSION()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = (await metaRes.json()) as { url?: string };
  if (!meta.url) throw new Error("mídia sem url");
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  return Buffer.from(await bin.arrayBuffer());
}
