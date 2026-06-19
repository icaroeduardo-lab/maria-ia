import { test } from "node:test";
import assert from "node:assert/strict";
import { mascararCpf, mascararTelefone, mascararEmail, mascararAssistido } from "../src/mask.js";

test("mascararCpf mostra só o 9º dígito", () => {
  assert.equal(mascararCpf("11144477735"), "•••.•••.••7-••");
  assert.equal(mascararCpf("111.444.777-35"), "•••.•••.••7-••");
});

test("mascararCpf devolve o valor cru se não tiver 11 dígitos", () => {
  assert.equal(mascararCpf("123"), "123");
  assert.equal(mascararCpf(""), "");
  assert.equal(mascararCpf(null), "");
  assert.equal(mascararCpf(undefined), "");
});

test("mascararTelefone mostra só os 2 últimos dígitos", () => {
  assert.equal(mascararTelefone("21988887777"), "••••••77");
  assert.equal(mascararTelefone("(21) 98888-7777"), "••••••77");
});

test("mascararTelefone trata vazio e curto", () => {
  assert.equal(mascararTelefone(""), "");
  assert.equal(mascararTelefone(null), "");
  assert.equal(mascararTelefone("a"), "••••");
});

test("mascararEmail preserva 2 primeiras letras e o TLD", () => {
  assert.equal(mascararEmail("joao.silva@gmail.com"), "jo•••@•••.com");
  assert.equal(mascararEmail("ab@dominio.gov.br"), "ab•••@•••.br");
});

test("mascararEmail devolve cru se não for email", () => {
  assert.equal(mascararEmail("semarroba"), "semarroba");
  assert.equal(mascararEmail(""), "");
});

test("mascararAssistido mascara cpf/telefone/email/nomeMae e preserva o resto", () => {
  const m = mascararAssistido({
    nome: "João da Silva",
    cpf: "11144477735",
    telefone: "21988887777",
    email: "joao@x.com",
    nomeMae: "Maria Aparecida Silva",
    municipio: "Rio de Janeiro",
  });
  assert.equal(m.nome, "João da Silva");
  assert.equal(m.municipio, "Rio de Janeiro");
  assert.equal(m.cpf, "•••.•••.••7-••");
  assert.equal(m.telefone, "••••••77");
  assert.equal(m.email, "jo•••@•••.com");
  assert.equal(m.nomeMae, "Maria •••");
});

test("mascararAssistido não inventa campos ausentes", () => {
  const m = mascararAssistido({ nome: "Ana" });
  assert.deepEqual(m, { nome: "Ana" });
});
