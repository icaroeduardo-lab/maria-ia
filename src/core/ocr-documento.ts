import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";
import type { MimeAceito } from "./documentos.js";

// Verificação de documento por OCR (card #20260203). Fase anterior (#20260129,
// src/core/documentos.ts) já sobe foto/PDF do documento pro bucket privado
// durante o cadastro (node `pergunta` tipoPergunta:"documento") — mas só grava
// metadado (nome/tamanho/mimeType) em dadosColetados, NUNCA a key/URL do S3
// (LGPD). Este módulo faz o outro lado: acha a KEY do documento mais recente
// da sessão por ListObjectsV2 (usada só pra derivar a key do resultado da
// lambda de OCR, ver ocr-resultado-textract.ts) e compara nome/CPF/data de
// nascimento extraídos com o que o assistido já digitou.
//
// HISTÓRICO (issue #20260214): até aqui, esta rota rodava OCR AO VIVO via
// Bedrock multimodal (extrairDadosDocumento, chamada síncrona no meio do
// turno de conversa) toda vez que o fluxo chegava no node `api` de
// verificação. Trocado por leitura do resultado já pronto da lambda
// assíncrona de Textract (src/lambdas/ocr-documento-textract/handler.ts),
// que roda automaticamente no upload — normalmente já terminou antes do
// fluxo chegar aqui. `extrairDadosDocumento`/Bedrock foi removida (sem
// outro call site) — se for necessário reavaliar OCR via Bedrock no futuro,
// ver histórico do git deste arquivo (era só o pipeline usado por esta
// rota, nada mais dependia dele).
//
// LGPD: nenhuma função aqui loga nome/CPF em texto claro — só booleans de
// match saem pro chamador (rota em src/api/routes/documentos.ts).

const s3 = new S3Client({ region: env.awsRegion() });

// Mantido pra tipar o protótipo histórico do Textract AnalyzeID (issue #194,
// src/core/ocr-documento-textract.ts) — não tem mais consumidor no pipeline
// ativo (ele já não baixa bytes, só a key), mas remover quebraria a
// assinatura daquele módulo (mantido só como registro, ver comentário lá).
export interface DocumentoBaixado {
  buffer: Buffer;
  mimeType: MimeAceito;
}

// Acha a KEY (não os bytes) do documento mais recente enviado nessa sessão
// (pode haver mais de 1 upload — ex: retry depois de um arquivo ilegível).
// null = nenhum documento encontrado (sessão nunca fez upload, ou já expirou
// pela retenção do bucket — infra/terraform/s3-documentos.tf, var.
// documentos_retencao_dias). Não baixa/sniffa o conteúdo — a leitura do
// resultado (ocr-resultado-textract.ts) só precisa da key pra derivar onde a
// lambda gravou o JSON extraído; quem valida o tipo de arquivo na origem é a
// própria lambda (grava `{erro: "assinatura não reconhecida"}` quando não é
// PDF/JPEG/PNG).
export async function buscarKeyDocumentoMaisRecente(sessionId: string): Promise<string | null> {
  const prefixo = `documentos/${sessionId}/`;
  const lista = await s3.send(
    new ListObjectsV2Command({ Bucket: env.s3BucketDocumentos(), Prefix: prefixo })
  );
  const objetos = lista.Contents ?? [];
  if (!objetos.length) return null;

  const maisRecente = objetos.reduce((a, b) =>
    (b.LastModified?.getTime() ?? 0) > (a.LastModified?.getTime() ?? 0) ? b : a
  );
  return maisRecente.Key ?? null;
}

export interface DadosExtraidos {
  nome: string | null;
  cpf: string | null;
  dataNascimento: string | null;
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
