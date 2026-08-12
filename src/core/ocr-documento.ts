import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
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

const s3 = new S3Client({ region: env.awsRegion() });

const model = new ChatBedrockConverse({
  model: env.bedrockOcrModelId(),
  region: env.awsRegion(),
  temperature: 0,
});

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

const ExtracaoSchema = z.object({
  // Campo de raciocínio ANTES dos valores finais — de propósito: saída
  // estruturada direto (sem espaço pra "pensar") mostrou-se menos precisa em
  // documento real complexo (CNH tem 2 números de 11 dígitos parecidos e 3
  // datas) do que uma resposta em texto livre pedindo a mesma extração —
  // achado testando ao vivo 2026-08-12. Preencher este campo primeiro força
  // o modelo a citar o rótulo exato de cada campo antes de decidir o valor,
  // reduzindo confusão entre campos vizinhos parecidos.
  raciocinio: z
    .string()
    .describe(
      "Antes de responder: cite o RÓTULO exato de cada campo que você está lendo no documento (ex: 'CPF está no campo rotulado 6 CPF, valor X; NÃO é o campo 5 Nº REGISTRO'). 1-3 frases curtas, uma por campo encontrado."
    ),
  nome: z
    .string()
    .nullish()
    .describe("Nome completo da pessoa exatamente como está impresso no documento de identidade"),
  cpf: z.string().nullish().describe("Número do CPF como está impresso no documento (com ou sem pontuação)"),
  dataNascimento: z
    .string()
    .nullish()
    .describe(
      "Data de nascimento exatamente como está impressa no documento (qualquer formato). Null se o documento não trouxer essa informação (ex: alguns modelos de CNH mais antigos)."
    ),
});

export interface DadosExtraidos {
  nome: string | null;
  cpf: string | null;
  dataNascimento: string | null;
}

// OCR via Bedrock multimodal — sem Textract: um modelo Claude com visão já lê
// o documento e devolve nome/CPF estruturados (Zod), mesmo padrão de
// src/core/nodes/atendimento/extrator.ts. PDF vai como "file" block (Bedrock
// Converse "document"); imagem vai como "image_url" (mesmo formato do
// exemplo oficial do @langchain/aws). Suporte a PDF depende do modelo
// configurado suportar o bloco "document" do Converse — nem todo modelo
// Claude 3 suporta; ajustar BEDROCK_OCR_MODEL_ID se precisar de um modelo
// mais recente só pra esta feature.
export async function extrairDadosDocumento(doc: DocumentoBaixado): Promise<DadosExtraidos> {
  const base64 = doc.buffer.toString("base64");
  const blocoArquivo =
    doc.mimeType === "application/pdf"
      ? { type: "file" as const, source_type: "base64" as const, mime_type: doc.mimeType, data: base64 }
      : { type: "image_url" as const, image_url: { url: `data:${doc.mimeType};base64,${base64}` } };

  const resultado = await model.withStructuredOutput(ExtracaoSchema).invoke([
    new SystemMessage(
      "Você lê documentos de identidade brasileiros (RG, CNH, certidão de nascimento). Extraia o nome completo, o CPF e a data de nascimento exatamente como aparecem no documento.\n\n" +
        "ATENÇÃO — esses documentos têm vários campos parecidos, não confunda:\n" +
        '- CPF: é o campo rotulado exatamente "CPF" (formato NNN.NNN.NNN-NN). NUNCA use o "Nº DE REGISTRO" da CNH (outro número de 11 dígitos, rotulado "5 Nº REGISTRO" ou similar) nem o "DOC IDENTIDADE"/RG — são campos diferentes.\n' +
        '- Data de nascimento: é a data dentro do campo "DATA, LOCAL E UF DE NASCIMENTO" (ou "3" na CNH). NUNCA use "DATA DE EMISSÃO"/"4a" nem "VALIDADE"/"4b" — são as outras duas datas que sempre aparecem no mesmo documento.\n' +
        '- Nome: geralmente rotulado "NOME E SOBRENOME" ou "2 e 1" — o nome completo da pessoa, não o campo "FILIAÇÃO" (nome dos pais).\n\n' +
        "Nem todo documento traz os três campos — data de nascimento pode faltar. Nunca invente um valor — se não conseguir ler algum campo com segurança ou tiver dúvida sobre qual campo é qual, devolva null nele em vez de arriscar um campo errado."
    ),
    new HumanMessage({
      content: [
        { type: "text", text: "Extraia o nome completo, o CPF e a data de nascimento deste documento." },
        blocoArquivo,
      ],
    }),
  ]);

  return {
    nome: resultado.nome?.trim() || null,
    cpf: resultado.cpf?.trim() || null,
    dataNascimento: resultado.dataNascimento?.trim() || null,
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
