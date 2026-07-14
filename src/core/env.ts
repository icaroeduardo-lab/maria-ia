import { z } from "zod";

// Configuração central de ambiente — ponto único de acesso ao process.env.
// Tipada, com defaults. Getters (funções) para valores que podem ser injetados
// no boot (tokens/URLs) e que queremos poder sobrescrever em teste.

const num = (v: string | undefined, def: number) => (v ? Number(v) : def);
const semBarra = (v: string) => v.replace(/\/+$/, "");

export const env = {
  awsRegion: () => process.env.AWS_REGION ?? "us-east-1",
  port: () => num(process.env.PORT, 3000),
  databaseUrl: () => process.env.DATABASE_URL,
  jwtSecret: () => process.env.JWT_SECRET ?? "dev-secret-trocar-em-producao",

  // URLs de serviço
  selfUrl: () => process.env.SELF_URL ?? `http://localhost:${env.port()}`,
  publicUrl: () => process.env.PUBLIC_URL ?? env.selfUrl(),

  // Bedrock
  bedrockModelId: () => process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  bedrockKbId: () => process.env.BEDROCK_KB_ID,
  bedrockKbDsId: () => process.env.BEDROCK_KB_DS_ID,

  // WhatsApp (Cloud API)
  waAccessToken: () => process.env.WA_ACCESS_TOKEN,
  waPhoneNumberId: () => process.env.WA_PHONE_NUMBER_ID,
  waWebhookVerifyToken: () => process.env.WA_WEBHOOK_VERIFY_TOKEN,
  waGraphUrl: () => process.env.WA_GRAPH_URL ?? "https://graph.facebook.com",
  waApiVersion: () => process.env.WA_API_VERSION ?? "v23.0",

  // PDPJ (processos)
  pdpjApiUrl: () => semBarra(process.env.PDPJ_API_URL ?? ""),
  pdpjApiToken: () => process.env.PDPJ_API_TOKEN ?? "",

  // DPERJ (envio final)
  dperjApiUrl: () => process.env.DPERJ_API_URL,
  dperjApiKey: () => process.env.DPERJ_API_KEY,

  // Fila + storage + cache
  sqsQueueUrl: () => process.env.SQS_QUEUE_URL ?? "",
  s3Bucket: () => process.env.S3_BUCKET ?? "maria-ia",
  redisUrl: () => process.env.REDIS_URL ?? "",

  // Timers / limites
  conversaTtlDias: () => num(process.env.CONVERSA_TTL_DIAS, 30),
  retomadaMin: () => num(process.env.RETOMADA_MIN, 60),

  // Handoff pra atendente humano — webhook (POST) disparado quando uma
  // conversa entra em "aguardando". Vazio = notificação desligada.
  handoffWebhookUrl: () => process.env.HANDOFF_WEBHOOK_URL ?? "",
} as const;

// Schema leniente: valida FORMATO do que está setado (não exige nada — o app
// tem fallbacks de dev). Números malformados falham; URLs inválidas falham.
const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  CONVERSA_TTL_DIAS: z.coerce.number().int().positive().optional(),
  RETOMADA_MIN: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().url().optional().or(z.literal("")),
  SELF_URL: z.string().url().optional().or(z.literal("")),
  PUBLIC_URL: z.string().url().optional().or(z.literal("")),
  SQS_QUEUE_URL: z.string().url().optional().or(z.literal("")),
  PDPJ_API_URL: z.string().url().optional().or(z.literal("")),
  HANDOFF_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
});

// Chamar no boot dos entrypoints (server/worker/jobs). Falha rápido em valor
// MALFORMADO (ex: PORT não-numérico); apenas AVISA sobre recomendados ausentes
// em produção — não derruba (o app degrada graciosamente).
export function validarEnv(): void {
  const r = envSchema.safeParse(process.env);
  if (!r.success) {
    console.error("[env] configuração inválida:", r.error.flatten().fieldErrors);
    throw new Error("variáveis de ambiente malformadas — ver log acima");
  }
  if (process.env.NODE_ENV === "production") {
    const rec: Array<[string, string | undefined]> = [
      ["DATABASE_URL", process.env.DATABASE_URL],
      ["SQS_QUEUE_URL", process.env.SQS_QUEUE_URL],
      ["WA_ACCESS_TOKEN", process.env.WA_ACCESS_TOKEN],
    ];
    const faltando = rec.filter(([, v]) => !v).map(([k]) => k);
    if (faltando.length) console.warn(`[env] recomendados ausentes em produção: ${faltando.join(", ")}`);
  }
  console.log(`[env] region=${env.awsRegion()} db=${env.databaseUrl() ? "ok" : "off"} fila=${env.sqsQueueUrl() ? "ok" : "off"}`);
}
