import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";
import { randomUUID } from "crypto";
import { env } from "./env.js";
import { baixarMidia } from "./graphMedia.js";

// Transcreve áudio do WhatsApp (mensagem de voz) com AWS Transcribe (pt-BR).
// Fluxo: baixa a mídia da Meta (graphMedia.ts) → S3 → job do Transcribe → texto.
// Áudios em audios/ expiram por lifecycle do bucket (são PII efêmera) —
// regra real em infra/terraform/s3-audios.tf (issue #75; antes desse
// arquivo o comentário aqui era só uma intenção, sem lifecycle de verdade).

const BUCKET = env.s3Bucket();

const s3 = new S3Client({ region: env.awsRegion() });
const transcribe = new TranscribeClient({ region: env.awsRegion() });

// Retorna o texto transcrito, ou "" em falha (o canal trata o fallback).
export async function transcreverAudioWA(mediaId: string, token: string | undefined): Promise<string> {
  if (!token) {
    console.warn("[transcribe] sem WA_ACCESS_TOKEN — não dá pra baixar o áudio");
    return "";
  }
  try {
    const audio = await baixarMidia(mediaId, token);
    const key = `audios/${randomUUID()}.ogg`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: audio, ContentType: "audio/ogg" }));

    const job = `wa-${randomUUID()}`;
    await transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: job,
      LanguageCode: "pt-BR",
      MediaFormat: "ogg", // WhatsApp envia voz em OGG/Opus
      Media: { MediaFileUri: `s3://${BUCKET}/${key}` },
    }));

    // poll até concluir (áudios de chat são curtos; teto de 60s)
    const inicio = Date.now();
    while (Date.now() - inicio < 60_000) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: job }));
      const st = r.TranscriptionJob?.TranscriptionJobStatus;
      if (st === "COMPLETED") {
        const uri = r.TranscriptionJob?.Transcript?.TranscriptFileUri;
        if (!uri) return "";
        const data = (await (await fetch(uri)).json()) as {
          results?: { transcripts?: { transcript?: string }[] };
        };
        const texto = data.results?.transcripts?.[0]?.transcript ?? "";
        console.log(`[transcribe] ${job} → "${texto.slice(0, 80)}"`);
        return texto.trim();
      }
      if (st === "FAILED") {
        console.error("[transcribe] job falhou:", r.TranscriptionJob?.FailureReason);
        return "";
      }
    }
    console.warn("[transcribe] timeout aguardando o job");
    return "";
  } catch (err) {
    console.error("[transcribe] erro:", err);
    return "";
  }
}
