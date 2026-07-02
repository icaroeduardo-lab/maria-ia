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

  // Fila + storage
  sqsQueueUrl: () => process.env.SQS_QUEUE_URL ?? "",
  s3Bucket: () => process.env.S3_BUCKET ?? "maria-ia",

  // Timers / limites
  conversaTtlDias: () => num(process.env.CONVERSA_TTL_DIAS, 30),
  retomadaMin: () => num(process.env.RETOMADA_MIN, 60),
} as const;
