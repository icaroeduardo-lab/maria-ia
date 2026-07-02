import { test } from "node:test";
import assert from "node:assert/strict";
import { montarMetadados } from "../src/core/resumo.js";

test("montarMetadados extrai identidade do resultado_cpf (string JSON)", () => {
  const m = montarMetadados({
    cpf: "11144477735",
    resultado_cpf: JSON.stringify({
      encontrado: true,
      dados: { nome: "João Silva", dataNascimento: "1985-03-22", nomeMae: "Maria", municipio: "Rio de Janeiro", uf: "RJ" },
    }),
    aceita_lgpd: "sim",
    categoria: "familia_pensao",
  });
  assert.equal(m.assistido.nome, "João Silva");
  assert.equal(m.assistido.cpf, "111.444.777-35");
  assert.equal(m.assistido.dataNascimento, "22/03/1985");
  assert.equal(m.assistido.municipio, "Rio de Janeiro / RJ");
  assert.equal(m.lgpd_aceito, true);
  assert.equal(m.categoria, "familia_pensao");
});

test("montarMetadados formata data no padrão da Receita (AAAAMMDD)", () => {
  const m = montarMetadados({ resultado_cpf: { dados: { dataNascimento: "19850322" } } });
  assert.equal(m.assistido.dataNascimento, "22/03/1985");
});

test("caso = só campos do tema, fora chaves de sistema e JSON", () => {
  const m = montarMetadados({
    aceita_lgpd: "sim",
    cpf: "11144477735",
    relato: "meu caso",
    categoria: "trabalhista",
    resultado_cpf: '{"dados":{}}',
    tem_filhos: "sim",
    valor_pensao: "500",
    dados_ok: "sim",
  });
  assert.deepEqual(m.caso, { tem_filhos: "sim", valor_pensao: "500" });
  assert.equal(m.relato, "meu caso");
});

test("lgpd_aceito é false quando não for 'sim'", () => {
  assert.equal(montarMetadados({ aceita_lgpd: "não" }).lgpd_aceito, false);
  assert.equal(montarMetadados({}).lgpd_aceito, false);
});

test("encaminhamento vem do agendamento e define o protocolo", () => {
  const m = montarMetadados({ agendamento: JSON.stringify({ agendamento_id: "AG-1", data: "2026-07-01" }) });
  assert.equal(m.encaminhamento?.tipo, "agendamento");
  assert.equal((m.encaminhamento as any).agendamento_id, "AG-1");
  assert.equal(m.protocolo, "AG-1");
});

test("telefone/email do fluxo têm prioridade sobre os do cadastro", () => {
  const m = montarMetadados({
    telefone: "21911112222",
    resultado_cpf: { dados: { telefone: "21999998888", email: "cad@x.com" } },
  });
  assert.equal(m.assistido.telefone, "21911112222");
  assert.equal(m.assistido.email, "cad@x.com");
});
