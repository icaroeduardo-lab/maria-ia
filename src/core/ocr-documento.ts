import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { env } from "./env.js";
import { mimeReal, type MimeAceito } from "./documentos.js";

// Verificação de documento por OCR (card #20260203). Fase anterior (#20260129,
// src/core/documentos.ts) já sobe foto/PDF do documento pro bucket privado
// durante o cadastro (node `pergunta` tipoPergunta:"documento") — mas só grava
// metadado (nome/tamanho/mimeType) em dadosColetados, NUNCA a key/URL do S3
// (LGPD). Este módulo faz o outro lado: acha o arquivo de volta por
// ListObjectsV2 no prefixo da sessão, roda OCR via Bedrock multimodal (Claude
// com visão — sem Textract, reaproveita a mesma infra de IA do resto do
// projeto) e compara nome/CPF extraídos com o que o assistido já digitou.
//
// LGPD: nenhuma função aqui loga nome/CPF em texto claro — só booleans de
// match saem pro chamador (rota em src/api/routes/documentos.ts).
//
// Chama o AWS SDK direto (BedrockRuntimeClient/ConverseCommand), NÃO
// @langchain/aws (usado no resto do engine) — achado ao vivo 2026-08-12,
// testando com PDF real (CNH-e do governo, ~290KB): a tradução de bloco de
// arquivo do @langchain/aws (ChatBedrockConverse.withStructuredOutput) falha
// silenciosamente pra esse documento específico (devolve texto tipo "não há
// informação", sem erro) — funcionava certinho num PDF sintético pequeno
// (gerado localmente pra teste), só quebrava no documento real. A mesma
// chamada via SDK puro (bytes idênticos, tool-calling) lê o documento
// corretamente. Não investigamos a causa raiz exata dentro do @langchain/aws
// (não é código nosso) — só confirmamos que bypassar resolve.

const s3 = new S3Client({ region: env.awsRegion() });
const bedrock = new BedrockRuntimeClient({ region: env.awsRegion() });

const FORMATO_DOCUMENTO: Record<string, "pdf"> = { "application/pdf": "pdf" };
const FORMATO_IMAGEM: Record<string, "jpeg" | "png"> = { "image/jpeg": "jpeg", "image/png": "png" };

export interface DocumentoBaixado {
  buffer: Buffer;
  mimeType: MimeAceito;
}

async function streamParaBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const trecho of stream) partes.push(Buffer.isBuffer(trecho) ? trecho : Buffer.from(trecho));
  return Buffer.concat(partes);
}

// Busca o documento mais recente enviado nessa sessão (pode haver mais de 1
// upload — ex: retry depois de um arquivo ilegível). null = nenhum documento
// encontrado (sessão nunca fez upload, ou já expirou pela retenção do bucket
// — infra/terraform/s3-documentos.tf, var.documentos_retencao_dias) ou o
// objeto encontrado não bate nenhuma assinatura conhecida.
export async function buscarDocumentoMaisRecente(sessionId: string): Promise<DocumentoBaixado | null> {
  const prefixo = `documentos/${sessionId}/`;
  const lista = await s3.send(
    new ListObjectsV2Command({ Bucket: env.s3BucketDocumentos(), Prefix: prefixo })
  );
  const objetos = lista.Contents ?? [];
  if (!objetos.length) return null;

  const maisRecente = objetos.reduce((a, b) =>
    (b.LastModified?.getTime() ?? 0) > (a.LastModified?.getTime() ?? 0) ? b : a
  );
  if (!maisRecente.Key) return null;

  const obj = await s3.send(new GetObjectCommand({ Bucket: env.s3BucketDocumentos(), Key: maisRecente.Key }));
  if (!obj.Body) return null;
  const buffer = await streamParaBuffer(obj.Body as AsyncIterable<Uint8Array>);

  // magic bytes, nunca confia no metadado do S3 — mesmo racional de
  // src/core/documentos.ts (Content-Type é gravado a partir do upload
  // original, mas re-sniffar aqui evita depender dessa garantia).
  const tipoReal = mimeReal(buffer);
  if (!tipoReal) return null;
  return { buffer, mimeType: tipoReal };
}

export interface DadosExtraidos {
  nome: string | null;
  cpf: string | null;
  dataNascimento: string | null;
}

// Curto de propósito — achado ao vivo 2026-08-12 testando com PDF real (CNH-e
// do governo): um system prompt longo com lista de "não confunda X com Y"
// combinado com o campo `raciocinio` do schema (abaixo) fazia o modelo
// concluir erroneamente que o documento "só tem cabeçalho de assinatura
// digital, sem dados pessoais" — 4/4 tentativas reproduziram isso de forma
// determinística (mesmo em temperature 0). Prompt curto + raciocinio juntos
// leram o documento certo em 3/3 tentativas seguidas. Não investigamos por
// que a combinação longa quebra — só confirmamos empiricamente qual
// combinação funciona nesse documento real.
const SYSTEM_PROMPT =
  "Você lê documentos de identidade brasileiros (RG, CNH, certidão de nascimento). Extraia nome completo, CPF e data de nascimento exatamente como aparecem no documento. Nunca invente um valor.";

const FERRAMENTA_EXTRACAO = {
  toolSpec: {
    name: "extrair_dados_documento",
    description: "Registra os dados de identidade lidos do documento.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          raciocinio: {
            type: "string",
            description: "Cite o rótulo exato de cada campo que você leu no documento, 1-3 frases curtas.",
          },
          nome: {
            type: ["string", "null"],
            description:
              "Nome completo da pessoa exatamente como está impresso no documento. null se não conseguir ler com segurança.",
          },
          cpf: {
            type: ["string", "null"],
            description:
              "Número do CPF como está impresso no documento (com ou sem pontuação). null se não conseguir ler com segurança.",
          },
          dataNascimento: {
            type: ["string", "null"],
            description:
              "Data de nascimento exatamente como está impressa no documento (qualquer formato). null se o documento não trouxer essa informação ou não conseguir ler com segurança.",
          },
        },
        required: ["raciocinio", "nome", "cpf", "dataNascimento"],
      },
    },
  },
};

// OCR via Bedrock multimodal — sem Textract: o modelo lê o documento com
// visão e devolve nome/CPF/data de nascimento via tool-calling (saída
// estruturada). Chama BedrockRuntimeClient/ConverseCommand direto (ver
// comentário no topo do arquivo — não usa @langchain/aws pra este caso).
// PDF vai como content block "document"; imagem (jpeg/png) vai como
// "image". Suporte a PDF depende do modelo configurado suportar o bloco
// "document" do Converse — nem todo modelo Claude suporta; ajustar
// BEDROCK_OCR_MODEL_ID se precisar trocar.
export async function extrairDadosDocumento(doc: DocumentoBaixado): Promise<DadosExtraidos> {
  const formatoDocumento = FORMATO_DOCUMENTO[doc.mimeType];
  const conteudo = formatoDocumento
    ? [{ document: { format: formatoDocumento, name: "documento", source: { bytes: doc.buffer } } }]
    : [{ image: { format: FORMATO_IMAGEM[doc.mimeType] ?? "jpeg", source: { bytes: doc.buffer } } }];

  const resp = await bedrock.send(
    new ConverseCommand({
      modelId: env.bedrockOcrModelId(),
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: [
            { text: "Extraia o nome completo, o CPF e a data de nascimento deste documento." },
            ...conteudo,
          ],
        },
      ],
      toolConfig: {
        tools: [FERRAMENTA_EXTRACAO],
        toolChoice: { tool: { name: "extrair_dados_documento" } },
      },
      inferenceConfig: { temperature: 0 },
    })
  );

  const toolUse = resp.output?.message?.content?.find((b) => b.toolUse)?.toolUse;
  const input = (toolUse?.input ?? {}) as {
    nome?: string | null;
    cpf?: string | null;
    dataNascimento?: string | null;
  };

  return {
    nome: input.nome?.trim() || null,
    cpf: input.cpf?.trim() || null,
    dataNascimento: input.dataNascimento?.trim() || null,
  };
}

// ── Comparação tolerante ────────────────────────────────────────────────
// Nome: normaliza acento/caixa e tolera abreviação/pequeno erro de digitação
// (não exige string idêntica — nome digitado pode vir "Joao S. Pereira" e o
// documento trazer "João Silva Pereira"). CPF: exato, só dígitos.

const soDigitos = (v?: string | null): string => (v ?? "").replace(/\D/g, "");

function normalizarNome(v?: string | null): string {
  return (v ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// partículas de nome que não ajudam a diferenciar pessoa (evita falso
// negativo por causa de "de"/"da" faltando/sobrando)
const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e"]);

function tokensSignificativos(v?: string | null): string[] {
  return normalizarNome(v)
    .split(" ")
    .filter((t) => t.length > 0 && !PARTICULAS.has(t));
}

// bate exato OU um é prefixo do outro — inclui inicial isolada ("s" vs
// "silva"), que é a abreviação mais comum de nome do meio.
function tokensBatem(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// Limiar 0.7 aplicado sobre o MENOR dos dois nomes (não o maior — bug real
// achado 2026-08-12: cadastro geralmente tem nome abreviado/informal ("Icaro
// Albar") enquanto o documento sempre traz o nome legal completo ("Icaro Luiz
// Albar Eduardo"); dividir pelo maior penalizava esse caso legítimo demais —
// 2 de 2 tokens do cadastro batiam, mas 2/4 = 0.5 ficava abaixo do limiar.
// Dividir pelo menor: nome + sobrenome (2 tokens) exige os 2 batendo; nome
// composto (3+, no lado menor) tolera 1 token divergente (abreviação, erro
// de digitação, nome social).
export function nomesCompativeis(digitado?: string | null, extraido?: string | null): boolean {
  const nd = normalizarNome(digitado);
  const ne = normalizarNome(extraido);
  if (!nd || !ne) return false;
  if (nd === ne) return true;

  const a = tokensSignificativos(digitado);
  const b = tokensSignificativos(extraido);
  if (!a.length || !b.length) return false;

  const [menor, maior] = a.length <= b.length ? [a, b] : [b, a];
  const acertos = menor.filter((tm) => maior.some((tM) => tokensBatem(tm, tM))).length;
  return acertos / menor.length >= 0.7;
}

export function cpfsCompativeis(digitado?: string | null, extraido?: string | null): boolean {
  const a = soDigitos(digitado);
  const b = soDigitos(extraido);
  return a.length === 11 && a === b;
}

// Cadastro guarda dataNascimento em ISO (yyyy-MM-dd, validado pelo
// tipoPergunta "data" do engine) — extraído do documento pode vir em
// qualquer formato (dd/MM/yyyy, "12 de março de 1990" etc). Comparação
// tolerante: reduz os dois a só dígitos e casa contra a permutação
// dia-mês-ano OU ano-mês-dia (cobre OCR que já devolveu em ISO por engano).
// null = documento não trouxe data de nascimento — "não aplicável", não é
// uma divergência (ver compararComCadastro).
export function datasCompativeis(digitadoIso?: string | null, extraido?: string | null): boolean | null {
  if (!extraido) return null;
  const extraidoDigitos = soDigitos(extraido);
  if (extraidoDigitos.length !== 8) return null; // não deu pra ler uma data completa

  const [ano, mes, dia] = (digitadoIso ?? "").split("-");
  if (!ano || !mes || !dia) return false;
  const diaMesAno = `${dia.padStart(2, "0")}${mes.padStart(2, "0")}${ano}`;
  const anoMesDia = `${ano}${mes.padStart(2, "0")}${dia.padStart(2, "0")}`;
  return extraidoDigitos === diaMesAno || extraidoDigitos === anoMesDia;
}

export interface ResultadoVerificacao {
  match: boolean;
  detalhes: { nome_ok: boolean; cpf_ok: boolean; dataNascimento_ok: boolean | null };
}

// dataNascimento_ok null (documento não trouxe essa info) não derruba o
// match — só entra na conta quando o documento realmente tem o campo
// (pedido do usuário 2026-08-12: "caso tenha esses dados no documento, pode
// comparar").
export function compararComCadastro(
  extraido: DadosExtraidos,
  nomeCadastro?: string | null,
  cpfCadastro?: string | null,
  dataNascimentoCadastro?: string | null
): ResultadoVerificacao {
  const nome_ok = nomesCompativeis(nomeCadastro, extraido.nome);
  const cpf_ok = cpfsCompativeis(cpfCadastro, extraido.cpf);
  const dataNascimento_ok = datasCompativeis(dataNascimentoCadastro, extraido.dataNascimento);
  const match = nome_ok && cpf_ok && dataNascimento_ok !== false;
  return { match, detalhes: { nome_ok, cpf_ok, dataNascimento_ok } };
}
