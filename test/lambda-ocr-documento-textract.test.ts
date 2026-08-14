process.env.AWS_ACCESS_KEY_ID = "teste-invalido";
process.env.AWS_SECRET_ACCESS_KEY = "teste-invalido";
process.env.DATABASE_URL = "";

import { test } from "node:test";
import assert from "node:assert/strict";
import { extrairCamposDoTexto } from "../src/lambdas/ocr-documento-textract/handler.js";

// Lambda de extração automática (evento S3 → Textract DetectDocumentText →
// regex/heurística sobre texto bruto). Pivô de abordagem: a versão anterior
// usava AnalyzeID (campos estruturados de doc de identidade); o usuário
// corrigiu pra extração de texto genérica (qualquer documento, não só
// identidade), então o mapeamento agora é regex sobre linhas de texto, não
// mais sobre campos tipados da AWS. Teste cobre só extrairCamposDoTexto
// (puro, sem tocar AWS) — mesmo racional de test/ocr-documento-textract.test.ts.

test("extrairCamposDoTexto: CPF formatado tem prioridade e confiança alta", () => {
  const r = extrairCamposDoTexto(["REPÚBLICA FEDERATIVA DO BRASIL", "CPF: 111.444.777-35", "outros dizeres"]);
  assert.equal(r.cpf.valor, "111.444.777-35");
  assert.equal(r.cpf.confianca, "alta");
});

test("extrairCamposDoTexto: sem CPF formatado, cai pra 11 dígitos crus com confiança baixa", () => {
  const r = extrairCamposDoTexto(["Documento nº 12345", "11144477735", "validade 2030"]);
  assert.equal(r.cpf.valor, "11144477735");
  assert.equal(r.cpf.confianca, "baixa");
});

test("extrairCamposDoTexto: 11 dígitos colados a outros dígitos não conta como CPF cru", () => {
  const r = extrairCamposDoTexto(["numero de serie 9911144477735221"]);
  assert.equal(r.cpf.valor, null);
  assert.equal(r.cpf.confianca, "nao_encontrado");
});

test("extrairCamposDoTexto: data perto do rótulo 'nascimento' tem confiança alta", () => {
  const r = extrairCamposDoTexto([
    "NOME: JOAO PEREIRA",
    "DATA DE NASCIMENTO",
    "15/03/1990",
    "validade 10/03/2030",
  ]);
  assert.equal(r.dataNascimento.valor, "15/03/1990");
  assert.equal(r.dataNascimento.confianca, "alta");
});

test("extrairCamposDoTexto: data solta no texto sem rótulo reconhecível cai pra confiança baixa", () => {
  const r = extrairCamposDoTexto(["expedido em 10/03/2030", "algum outro texto"]);
  assert.equal(r.dataNascimento.valor, "10/03/2030");
  assert.equal(r.dataNascimento.confianca, "baixa");
});

test("extrairCamposDoTexto: nome extraído da mesma linha do rótulo 'Nome:'", () => {
  const r = extrairCamposDoTexto(["DOCUMENTO NACIONAL", "Nome: Maria da Silva", "CPF: 111.444.777-35"]);
  assert.equal(r.nome.valor, "Maria da Silva");
  assert.equal(r.nome.confianca, "alta");
});

test("extrairCamposDoTexto: rótulo 'NOME' sozinho numa linha usa o valor da linha seguinte", () => {
  const r = extrairCamposDoTexto(["NOME", "JOAO PEREIRA DA SILVA", "CPF 11144477735"]);
  assert.equal(r.nome.valor, "JOAO PEREIRA DA SILVA");
  assert.equal(r.nome.confianca, "alta");
});

// Regressão do teste ao vivo em produção (foto de CNH real, baixa
// qualidade): layout em 2 colunas fez o Textract ler o rótulo de nome
// ("2e1 NOME E SOBRENOME" — "2e1" é "2º" degradado pelo OCR) seguido da
// linha de OUTRO campo, "1a HABILITACAO" (coluna vizinha), e só depois o
// nome de verdade. Antes desta correção a heurística olhava só a linha
// imediatamente seguinte ao rótulo e pegava "1a HABILITACAO" (rejeitado
// pelo length>=3 do valor da mesma linha, mas ainda teria sido aceito como
// "próxima linha" na versão antiga) ou caía no fallback fraco. Agora
// procura até 3 linhas à frente, pulando linha que parece rótulo de outro
// campo (numeração "1a" no início + palavra "HABILITACAO" reconhecida).
test("extrairCamposDoTexto: layout intercalado (rótulo → linha de OUTRO campo → nome de verdade) acha o nome pulando o campo errado", () => {
  const r = extrairCamposDoTexto([
    "2e1 NOME E SOBRENOME",
    "1a HABILITACAO",
    "ICARO LUIZ ALBAR EDUARDO",
    "CPF 11144477735",
  ]);
  assert.equal(r.nome.valor, "ICARO LUIZ ALBAR EDUARDO");
  assert.equal(r.nome.confianca, "alta");
});

test("extrairCamposDoTexto: sem rótulo 'nome' reconhecível, cai pro fallback fraco (linha em maiúsculas)", () => {
  const r = extrairCamposDoTexto([
    "Documento de identificação nº 123456",
    "MARIA DA SILVA COSTA",
    "validade 10/03/2030",
  ]);
  assert.equal(r.nome.valor, "MARIA DA SILVA COSTA");
  assert.equal(r.nome.confianca, "baixa");
});

// Correção do achado ao vivo em produção (foto de CNH real, sem rótulo
// "nome" legível): o fallback fraco escolhia boilerplate de cabeçalho do
// documento ("REPUBLICA FEDERATIVA DO BRASIL") em vez do nome de verdade,
// só porque vinha primeiro no texto e também batia no padrão "linha toda
// maiúscula com 2+ palavras". Lista de boilerplate agora filtra isso, tanto
// no fallback fraco quanto na busca nas linhas seguintes ao rótulo de nome.
test("extrairCamposDoTexto: fallback fraco ignora boilerplate de documento oficial e acha o nome real", () => {
  const r = extrairCamposDoTexto([
    "REPÚBLICA FEDERATIVA DO BRASIL",
    "MINISTERIO DA INFRAESTRUTURA",
    "CARTEIRA NACIONAL DE HABILITACAO",
    "MARIA DA SILVA COSTA",
    "validade 10/03/2030",
  ]);
  assert.equal(r.nome.valor, "MARIA DA SILVA COSTA");
  assert.equal(r.nome.confianca, "baixa");
});

test("extrairCamposDoTexto: nenhum campo reconhecível devolve tudo null/nao_encontrado", () => {
  const r = extrairCamposDoTexto(["texto qualquer", "sem nenhum padrão reconhecido aqui"]);
  assert.equal(r.nome.valor, null);
  assert.equal(r.nome.confianca, "nao_encontrado");
  assert.equal(r.cpf.valor, null);
  assert.equal(r.cpf.confianca, "nao_encontrado");
  assert.equal(r.dataNascimento.valor, null);
  assert.equal(r.dataNascimento.confianca, "nao_encontrado");
});

test("extrairCamposDoTexto: lista de linhas vazia devolve tudo null e linhasBrutas vazio", () => {
  const r = extrairCamposDoTexto([]);
  assert.equal(r.nome.valor, null);
  assert.equal(r.cpf.valor, null);
  assert.equal(r.dataNascimento.valor, null);
  assert.deepEqual(r.linhasBrutas, []);
});

test("extrairCamposDoTexto: linhasBrutas preserva o texto original (nada é normalizado/perdido)", () => {
  const linhas = ["Nome: João da Silva", "CPF: 111.444.777-35", "Nascimento 15/03/1990"];
  const r = extrairCamposDoTexto(linhas);
  assert.deepEqual(r.linhasBrutas, linhas);
});
