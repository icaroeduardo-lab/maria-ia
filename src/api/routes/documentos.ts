import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import {
  buscarDocumentoMaisRecente,
  compararComCadastro,
  extrairDadosDocumento,
} from "../../core/ocr-documento.js";

// POST /api/documentos/verificar — issue #20260203 (fase anterior #20260129
// já sobe o documento pro S3, ver src/core/documentos.ts). Chamado pelo nó
// `api` do fluxo "Cadastro de Assistido", depois que o nó `pergunta`
// (tipoPergunta: "documento") já capturou a foto/PDF do documento de
// identidade. Busca o arquivo mais recente da sessão no bucket privado, roda
// OCR via Bedrock multimodal e compara nome/CPF extraídos com o que o
// assistido já digitou no cadastro (mesma sessão).
//
// Rota PÚBLICA (sem JWT, mesmo padrão de /api/kyc/* e /api/upload-documento):
// autenticação é por posse do sessionId (thread_id da conversa).
//
// nome/cpf digitados: o nó api manda no corpo quando o fluxo configura
// camposCorpo (ex: ["nome","cpf"]) — recomendado, funciona mesmo sem Postgres
// disponível. Sem isso no corpo, cai pro snapshot em
// Conversation.dadosColetados (Postgres) da mesma sessão.
//
// LGPD: a resposta nunca inclui nome/CPF cru — só os booleans de
// src/core/ocr-documento.ts#compararComCadastro. Nenhum log aqui imprime PII.

export async function documentosFlowRoutes(app: FastifyInstance) {
  app.post("/api/documentos/verificar", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = String(body.sessionId ?? body._sessao ?? "").trim();
    if (!sessionId) return reply.code(400).send({ erro: "sessionId (ou _sessao) obrigatório" });

    let nomeCadastro = typeof body.nome === "string" ? body.nome : undefined;
    let cpfCadastro = typeof body.cpf === "string" ? body.cpf : undefined;
    // dataNascimento é opcional (nem todo fluxo/documento tem essa info) —
    // por isso não entra na checagem de 422 abaixo junto com nome/cpf.
    let dataNascimentoCadastro = typeof body.dataNascimento === "string" ? body.dataNascimento : undefined;

    if ((!nomeCadastro || !cpfCadastro || !dataNascimentoCadastro) && prisma) {
      const conversa = await prisma.conversation.findUnique({ where: { sessionId } });
      const dados = (conversa?.dadosColetados as Record<string, unknown>) ?? {};
      nomeCadastro ??= typeof dados.nome === "string" ? dados.nome : undefined;
      cpfCadastro ??= typeof dados.cpf === "string" ? dados.cpf : undefined;
      dataNascimentoCadastro ??= typeof dados.dataNascimento === "string" ? dados.dataNascimento : undefined;
    }

    if (!nomeCadastro || !cpfCadastro) {
      return reply.code(422).send({ erro: "nome/cpf ainda não coletados nesta sessão" });
    }

    const documento = await buscarDocumentoMaisRecente(sessionId);
    if (!documento) {
      return reply.code(404).send({ erro: "nenhum documento encontrado para esta sessão" });
    }

    try {
      const extraido = await extrairDadosDocumento(documento);
      const resultado = compararComCadastro(extraido, nomeCadastro, cpfCadastro, dataNascimentoCadastro);
      console.log(
        `[documentos] verificar: sessão ${sessionId} → match=${resultado.match} ` +
          `(nome_ok=${resultado.detalhes.nome_ok}, cpf_ok=${resultado.detalhes.cpf_ok}, ` +
          `dataNascimento_ok=${resultado.detalhes.dataNascimento_ok})`
      );
      return resultado;
    } catch (err) {
      console.error(
        `[documentos] verificar: falha ao processar documento (sessão ${sessionId}):`,
        err instanceof Error ? err.message : err
      );
      return reply.code(500).send({ erro: "falha ao processar o documento" });
    }
  });
}
