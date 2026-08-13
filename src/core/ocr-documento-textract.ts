import { AnalyzeIDCommand, TextractClient, type IdentityDocumentField } from "@aws-sdk/client-textract";
import { env } from "./env.js";
import type { DadosExtraidos, DocumentoBaixado } from "./ocr-documento.js";

// Segunda via de OCR avaliada pra issue #194 — AWS Textract `AnalyzeID`, a API
// do Textract feita especificamente pra documento de identidade (devolve
// campos já tipados: FIRST_NAME, DATE_OF_BIRTH etc, ao contrário do Bedrock
// que precisa "ler" texto livre). A hipótese era essa tipagem ser mais
// confiável que pedir pro LLM interpretar o documento.
//
// VEREDITO (testado ao vivo 2026-08-13, mesmo PDF real de CNH-e usado pra
// validar o Bedrock, nome verdadeiro "Icaro Luiz Albar Eduardo"):
//   Bedrock (extrairDadosDocumento):  nome="ICARO LUIZ ALBAR EDUARDO" ✅ cpf="145.630.307-33" ✅ dataNascimento="11/08/1992" ✅
//   Textract AnalyzeID (esta função): nome="ANDRE FERREIRA EDUARDO DETRAN JUNIOR" ❌ cpf="" (não achou) ❌ dataNascimento="11/08/1992" ✅
// AnalyzeID leu "DETRAN" (a sigla do órgão emissor impressa na CNH) como
// LAST_NAME com 91% de confiança — não é ruído de OCR, é o modelo aplicando
// um template de documento errado. Isso bate com a documentação oficial da
// AWS (docs.aws.amazon.com/textract/latest/dg/how-it-works-identity.html):
// AnalyzeID "extract relevant information from passports, driver licenses,
// and other identity documentation issued by the US Government" — RG/CNH/
// certidão brasileira NÃO são um tipo de documento suportado, só documentos
// americanos. Não existe campo dedicado a CPF (o mais próximo,
// DOCUMENT_NUMBER, é pro número de license americano e veio vazio/confiança
// ~0 no teste real).
//
// DECISÃO: Textract NÃO substitui o Bedrock nem entra como fallback — não
// resolve o problema, é uma regressão de precisão pro nosso caso de uso.
// `extrairDadosDocumento` (ocr-documento.ts) continua sendo o único caminho
// usado por `compararComCadastro`/rotas. Esta função fica implementada e
// testada (cobre o pedido de avaliar Textract, issue #194) mas NUNCA é
// chamada em produção — não wire isso em documentos.ts sem novo teste ao
// vivo mostrando que o cenário mudou (ex: DPERJ passar a aceitar só
// passaporte, ou a Maria passar a atender documento estrangeiro).
//
// Formato aceito: apesar de `Document.Bytes` na doc oficial da API dizer
// "must be in PNG or JPEG format", o teste ao vivo aceitou o PDF puro sem
// erro (mesmo buffer usado no Bedrock) — comportamento não documentado, não
// confiar nele preventivamente noutro contexto; mantido aqui só porque foi
// o que se observou. Máximo 5MB pra Bytes (limite síncrono do Textract).
const textract = new TextractClient({ region: env.awsRegion() });

function valorDoCampo(campos: IdentityDocumentField[], tipo: string): string {
  const campo = campos.find((c) => c.Type?.Text === tipo);
  return campo?.ValueDetection?.Text?.trim() ?? "";
}

// Pura (sem chamada AWS) — separada de propósito pra testar o mapeamento sem
// depender de mock de SDK, mesmo racional de nomesCompativeis/cpfsCompativeis
// em ocr-documento.ts: determinística, sem tocar rede.
export function mapearCamposAnalyzeId(campos: IdentityDocumentField[]): DadosExtraidos {
  if (!campos.length) return { nome: null, cpf: null, dataNascimento: null };

  const partesNome = [
    valorDoCampo(campos, "FIRST_NAME"),
    valorDoCampo(campos, "MIDDLE_NAME"),
    valorDoCampo(campos, "LAST_NAME"),
    valorDoCampo(campos, "SUFFIX"),
  ].filter(Boolean);

  // CPF não tem campo dedicado no AnalyzeID (ver comentário acima) —
  // DOCUMENT_NUMBER é o mais próximo disponível, mas é calibrado pra número
  // de license americano; tratado aqui como melhor esforço, nunca confiável
  // sozinho pra documento brasileiro.
  const cpf = valorDoCampo(campos, "DOCUMENT_NUMBER");
  const dataNascimento = valorDoCampo(campos, "DATE_OF_BIRTH");

  return {
    nome: partesNome.length ? partesNome.join(" ") : null,
    cpf: cpf || null,
    dataNascimento: dataNascimento || null,
  };
}

export async function extrairDadosDocumentoTextract(doc: DocumentoBaixado): Promise<DadosExtraidos> {
  const resp = await textract.send(new AnalyzeIDCommand({ DocumentPages: [{ Bytes: doc.buffer }] }));
  const campos = resp.IdentityDocuments?.[0]?.IdentityDocumentFields ?? [];
  return mapearCamposAnalyzeId(campos);
}
