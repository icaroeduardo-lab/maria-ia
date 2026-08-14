import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { buscarKeyDocumentoMaisRecente, compararComCadastro } from "../../core/ocr-documento.js";
import { lerResultadoTextractComRetry } from "../../core/ocr-resultado-textract.js";
import { env } from "../../core/env.js";

// POST /api/documentos/verificar — issue #20260203 (fase anterior #20260129
// já sobe o documento pro S3, ver src/core/documentos.ts). Chamado pelo nó
// `api` do fluxo "Cadastro de Assistido", depois que o nó `pergunta`
// (tipoPergunta: "documento") já capturou a foto/PDF do documento de
// identidade. Acha a key do arquivo mais recente da sessão e lê o resultado
// já pronto da lambda de OCR assíncrona (issue #20260214,
// src/core/ocr-resultado-textract.ts + src/lambdas/ocr-documento-textract/
// handler.ts) — NÃO roda mais OCR ao vivo via Bedrock aqui (ver histórico no
// topo de src/core/ocr-documento.ts). Compara nome/CPF/data de nascimento
// extraídos com o que o assistido já digitou no cadastro (mesma sessão).
//
// Rota PÚBLICA (sem JWT, mesmo padrão de /api/kyc/* e /api/upload-documento):
// autenticação é por posse do sessionId (thread_id da conversa).
//
// nome/cpf digitados: o nó api manda no corpo quando o fluxo configura
// camposCorpo (ex: ["nome","cpf"]) — recomendado, funciona mesmo sem Postgres
// disponível. Sem isso no corpo, cai pro snapshot em
// Conversation.dadosColetados (Postgres) da mesma sessão.
//
// TIMEOUT/FALLBACK (a lambda pode não ter terminado ainda, principalmente
// PDF — polling assíncrono de até 90s dentro dela): a leitura do resultado
// espera com retry/backoff dentro de um orçamento próprio, bem menor que
// esses 90s (ver decisão completa no topo de ocr-resultado-textract.ts) —
// precisa caber com folga dentro do timeoutMs (10s por padrão) do node `api`
// do builder que chama esta rota (src/core/engine/builder.ts:~356), senão o
// node aborta a conexão antes da resposta sair. Estourado o orçamento, a
// rota NÃO trava nem devolve erro — responde 200 com `status:"processando"`
// e match:false (fail-closed), pra o fluxo decidir o que fazer (reperguntar,
// tentar de novo depois etc) em vez de travar a conversa. O corpo aceita
// `orcamentoMs` opcional (clamped entre 1s e 95s — teto cobre o polling de
// ~90s da lambda pra PDF, ver ORCAMENTO_MAX_MS abaixo) pra fluxos que
// queiram esperar mais — só funciona de fato combinado com um `timeoutMs`
// maior no node `api` correspondente (dado de fluxo, fora do escopo deste
// arquivo).
//
// LGPD: a resposta nunca inclui nome/cpf cru — só os booleans de
// src/core/ocr-documento.ts#compararComCadastro. Nenhum log aqui imprime PII.

const ORCAMENTO_MIN_MS = 1000;
// Teto subido de 60s pra 95s (issue timeout PDF Textract): a lambda
// ocr-documento-textract faz polling assíncrono de até ~90s (seu próprio
// timeout de execução é 120s — ver POLL_ORCAMENTO_MS no handler e o
// comentário de decisão em ocr-resultado-textract.ts). 95s dá margem de 5s
// sobre o pior caso do polling. Só tem efeito de fato se o `timeoutMs` do
// node "api" do fluxo correspondente também subir (senão o node aborta a
// conexão antes — ver builder.ts:~356), o que fica a cargo do agente
// `fluxos` na config do node.
const ORCAMENTO_MAX_MS = 95_000;

function orcamentoMsDoCorpo(body: Record<string, unknown>): number | undefined {
  const bruto = Number(body.orcamentoMs);
  if (!Number.isFinite(bruto) || bruto <= 0) return undefined;
  return Math.min(ORCAMENTO_MAX_MS, Math.max(ORCAMENTO_MIN_MS, bruto));
}

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

    const documentoKey = await buscarKeyDocumentoMaisRecente(sessionId);
    if (!documentoKey) {
      return reply.code(404).send({ erro: "nenhum documento encontrado para esta sessão" });
    }

    try {
      const leitura = await lerResultadoTextractComRetry(env.s3BucketDocumentos(), documentoKey, {
        orcamentoMs: orcamentoMsDoCorpo(body),
      });

      if (leitura.status === "ainda_processando") {
        console.log(`[documentos] verificar: sessão ${sessionId} → resultado do OCR ainda não está pronto`);
        return {
          match: false,
          detalhes: { nome_ok: false, cpf_ok: false, dataNascimento_ok: null },
          status: "processando",
        };
      }
      if (leitura.status === "erro_extracao") {
        console.error(
          `[documentos] verificar: falha na extração automática (sessão ${sessionId}): ${leitura.detalheErro}`
        );
        return reply.code(500).send({ erro: "falha ao processar o documento" });
      }

      const resultado = compararComCadastro(
        leitura.dados!,
        nomeCadastro,
        cpfCadastro,
        dataNascimentoCadastro
      );
      console.log(
        `[documentos] verificar: sessão ${sessionId} → match=${resultado.match} ` +
          `(nome_ok=${resultado.detalhes.nome_ok}, cpf_ok=${resultado.detalhes.cpf_ok}, ` +
          `dataNascimento_ok=${resultado.detalhes.dataNascimento_ok})`
      );
      return { ...resultado, status: "concluido" };
    } catch (err) {
      console.error(
        `[documentos] verificar: falha ao processar documento (sessão ${sessionId}):`,
        err instanceof Error ? err.message : err
      );
      return reply.code(500).send({ erro: "falha ao processar o documento" });
    }
  });
}
