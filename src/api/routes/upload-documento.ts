import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { processarMensagem } from "../../core/chat.js";
import { enviarWhatsApp } from "../../core/channels/whatsapp.js";
import { prisma } from "../../core/db.js";
import { cacheIncr } from "../../core/cache.js";
import { MIME_ACEITOS, TAMANHO_MAX_BYTES, mimeReal, salvarDocumento } from "../../core/documentos.js";

// POST /api/upload-documento — anexo enviado pelo assistido (comprovante de
// renda, identidade etc) durante o atendimento (issue #74). Rota PÚBLICA
// (sem JWT, como /api/kyc/*): auth é por posse do sessionId (thread_id da
// conversa), não por usuário logado. Avança a conversa no mesmo request —
// mirror de retomarWhatsApp() em kyc.ts.
//
// Fluxo: multipart { sessionId, file } → valida rate limit → conversa ativa →
// magic bytes (nunca confia no Content-Type declarado) → salva no bucket
// PRIVADO de documentos → processarMensagem(JSON do metadado) → { nome,
// tamanho, mimeType, messages }. NUNCA retorna URL/key do S3 (LGPD).

// limite de uploads por sessão — mesmo racional do rate limit do WhatsApp
// (card #20260122), janela fixa de 60s via cacheIncr (Redis + fallback memória)
const UPLOAD_RATE_LIMIT_MIN = 10;

export async function uploadDocumentoRoutes(app: FastifyInstance) {
  await app.register(fastifyMultipart, { limits: { fileSize: TAMANHO_MAX_BYTES, files: 1 } });

  app.post("/api/upload-documento", async (req, reply) => {
    // multipart: sessionId chega como campo separado do arquivo — precisamos
    // ler os parts na ordem em que a Meta/o cliente mandar (sessionId antes
    // do file é o esperado, mas tratamos os dois casos).
    let sessionId: string | undefined;
    let arquivo: { mimeTypeDeclarado?: string; filename?: string; buffer: Buffer } | undefined;

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const buffer = await part.toBuffer();
          arquivo = { mimeTypeDeclarado: part.mimetype, filename: part.filename, buffer };
        } else if (part.fieldname === "sessionId") {
          sessionId = String(part.value ?? "");
        }
      }
    } catch (err) {
      // fastify-multipart lança quando o arquivo excede o limits.fileSize configurado
      req.log?.warn?.({ err }, "[upload-documento] falha ao ler multipart");
      return reply.code(413).send({ erro: "arquivo grande demais (máx 10MB)" });
    }

    if (!sessionId) return reply.code(400).send({ erro: "sessionId obrigatório (campo multipart)" });

    // rate limit PRIMEIRO — barato (cache, sem tocar S3/DB), evita gastar
    // recursos com flood mesmo antes de saber se o banco está disponível.
    const chamadas = await cacheIncr(`upload-doc:ratelimit:${sessionId}`, 60);
    if (chamadas > UPLOAD_RATE_LIMIT_MIN) {
      return reply.code(429).send({ erro: "muitos uploads — aguarde um instante e tente de novo" });
    }

    if (!prisma) return reply.code(503).send({ erro: "banco não configurado" });

    const conversa = await prisma.conversation.findUnique({ where: { sessionId } });
    if (conversa?.status !== "active") {
      return reply.code(404).send({ erro: "conversa não encontrada ou não está ativa" });
    }

    if (!arquivo) return reply.code(400).send({ erro: "envie um arquivo (multipart, campo 'file')" });

    // magic bytes — ignora Content-Type declarado (spoofável), inclui .exe
    // renomeado com Content-Type: application/pdf
    const tipoReal = mimeReal(arquivo.buffer);
    if (!tipoReal || !MIME_ACEITOS.includes(tipoReal)) {
      return reply.code(415).send({ erro: "arquivo não reconhecido — envie foto (jpeg/png) ou PDF" });
    }

    const meta = await salvarDocumento(sessionId, arquivo.buffer, tipoReal, arquivo.filename ?? "documento");

    const canal = conversa.channel === "whatsapp" ? "whatsapp" : "web";
    const { newMessages } = await processarMensagem(sessionId, JSON.stringify(meta), canal);

    if (canal === "whatsapp") {
      const numero = sessionId.replace(/^wa:/, "");
      await enviarWhatsApp(numero, newMessages).catch((err) =>
        console.error("[upload-documento] falha ao enviar WhatsApp:", err)
      );
    }

    // mesmo shape de POST /api/chat — nunca serializa o BaseMessage bruto
    return {
      ...meta,
      messages: newMessages.map((m) => ({ role: m.getType(), content: m.content })),
    };
  });
}
