import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/core/db.js";
import { foraDeExpediente, formatarDiasSemana, invalidarEstilo } from "../src/core/config.js";
import { saudacao } from "../src/core/nodes/onboarding/saudacao.js";
import { montarApp } from "../src/api/app.js";
import type { GraphState } from "../src/core/state.js";

// Issue #79 — horário de funcionamento / aviso automático fora do expediente.
// Testes de integração REAIS contra o Postgres local (mesmo padrão da issue
// CSAT anterior), não guards de fonte. A suíte completa também roda com
// DATABASE_URL="" (padrão do CI, ver CLAUDE.md) — nesse modo `prisma` é null
// e este arquivo INTEIRO é pulado (skip, não falha) via SEM_BANCO abaixo.
const SEM_BANCO = prisma ? false : "requer DATABASE_URL (Postgres) — pulado no modo sem banco (padrão do CI)";
const db = prisma;

// Datas UTC específicas escolhidas p/ corresponder a um horário CONHECIDO em
// America/Sao_Paulo (UTC-3 o ano todo, sem horário de verão desde 2019).
// NUNCA usar `new Date(ano, mes, dia, hora)` aqui — isso usa o timezone do
// PROCESSO que roda o teste (que pode não ser America/Sao_Paulo, ex: CI em
// UTC), mascarando um bug de timezone. Verificado com Intl.DateTimeFormat:
//   2026-07-18T17:00:00Z → Sat 14:00 em America/Sao_Paulo
//   2026-07-21T13:00:00Z → Tue 10:00 em America/Sao_Paulo
const SABADO_14H_SP = new Date("2026-07-18T17:00:00.000Z");
const TERCA_10H_SP = new Date("2026-07-21T13:00:00.000Z");

async function setConfig(v: { horarioAtivo: boolean; diasSemana: number[]; horaInicio: string; horaFim: string }) {
  await db!.config.upsert({ where: { id: "default" }, update: v, create: { id: "default", ...v } });
  invalidarEstilo(); // limpa o cache de 60s do obterConfig() — senão o teste seguinte lê valor velho
}

// saudacao() chama foraDeExpediente() SEM data explícita (usa o relógio real,
// como no atendimento de verdade) — não dá pra fixar sábado 14h/terça 10h
// pra ela como fazemos com foraDeExpediente() diretamente. Pra testar a FIAÇÃO
// (saudacao acrescenta/omite o aviso conforme o resultado) de forma
// determinística e independente da hora real em que o teste roda, construímos
// a config em cima do dia de hoje em América/Sao_Paulo: dia excluído de
// diasSemana → sempre fora, dia incluído + janela 00:00–23:59 → sempre dentro.
function diaDeHojeEmSaoPaulo(): number {
  const NOMES: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(new Date());
  return NOMES[wd];
}

function textoDaMensagem(m: { content: unknown }): string {
  return typeof m.content === "string"
    ? m.content
    : (m.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? b.text : "")).join(" ");
}

// ── Cenário: Feature desligada nunca dispara aviso ──────────────────────────
test(
  "horarioAtivo=false: foraDeExpediente() é sempre false, inclusive num instante fixo claramente fora (sábado 14h SP)",
  { skip: SEM_BANCO },
  async () => {
    await setConfig({ horarioAtivo: false, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });

    // sábado 14h seria claramente fora — mas a feature está desligada
    assert.equal(await foraDeExpediente(SABADO_14H_SP), false);

    // saudacao() usa o relógio real (conversa nova de verdade) — mesmo assim,
    // com a feature desligada, nunca pode incluir o aviso.
    const r = await saudacao({} as GraphState);
    assert.equal(r.messages.length, 1, "só a saudação original, sem aviso de horário");
  }
);

// ── Cenário: Mensagem chega fora da janela configurada ──────────────────────
test(
  "horarioAtivo=true, sábado 14h SP (dia fora de diasSemana): foraDeExpediente() retorna true",
  { skip: SEM_BANCO },
  async () => {
    await setConfig({ horarioAtivo: true, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
    assert.equal(await foraDeExpediente(SABADO_14H_SP), true);
  }
);

test(
  "saudacao() acrescenta o aviso de horário quando a conversa começa fora do expediente",
  { skip: SEM_BANCO },
  async () => {
    // saudacao() consulta foraDeExpediente() com o relógio REAL (sem data
    // injetada — é assim que roda em produção). Pra provar a fiação de forma
    // determinística independente da hora real em que o teste roda, excluímos
    // o dia de HOJE (em America/Sao_Paulo) de diasSemana — isso garante
    // foraDeExpediente()=true agora mesmo, em qualquer hora do dia.
    const hoje = diaDeHojeEmSaoPaulo();
    const diasSemExcluirHoje = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== hoje);
    await setConfig({ horarioAtivo: true, diasSemana: diasSemExcluirHoje, horaInicio: "09:00", horaFim: "18:00" });

    const r = await saudacao({} as GraphState);
    assert.equal(r.messages.length, 2, "saudação + aviso extra de horário de funcionamento");
    const aviso = textoDaMensagem(r.messages[1]);
    assert.match(aviso, /09:00/);
    assert.match(aviso, /18:00/);
  }
);

// ── Cenário: Mensagem chega dentro da janela configurada ────────────────────
test(
  "horarioAtivo=true, terça 10h SP (dentro da janela): foraDeExpediente() retorna false",
  { skip: SEM_BANCO },
  async () => {
    await setConfig({ horarioAtivo: true, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
    assert.equal(await foraDeExpediente(TERCA_10H_SP), false);
  }
);

test("saudacao() NÃO acrescenta aviso quando a conversa começa dentro do expediente", { skip: SEM_BANCO }, async () => {
  // mesma lógica do teste anterior, invertida: hoje incluído em diasSemana e
  // janela cobrindo o dia inteiro (00:00–23:59) → garante dentro do
  // expediente agora mesmo, em qualquer hora do dia.
  const hoje = diaDeHojeEmSaoPaulo();
  await setConfig({ horarioAtivo: true, diasSemana: [hoje], horaInicio: "00:00", horaFim: "23:59" });

  const r = await saudacao({} as GraphState);
  assert.equal(r.messages.length, 1, "está no expediente — sem aviso extra");
});

// ── Timezone: independência do fuso do PROCESSO que roda o teste ───────────
test(
  "foraDeExpediente() calcula em America/Sao_Paulo mesmo com o timezone do processo forçado para outro fuso",
  { skip: SEM_BANCO },
  async () => {
    await setConfig({ horarioAtivo: true, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });

    const tzOriginal = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14 — o fuso mais distante de America/Sao_Paulo que existe
    try {
      // sanity check: sob esse TZ forçado, os métodos "ingênuos" do Date (que o
      // código NUNCA deve usar) já dão resultado errado para o mesmo instante —
      // prova que o teste de fato exercita um fuso diferente de America/Sao_Paulo.
      assert.notEqual(SABADO_14H_SP.getDay(), 6, "sanity: getDay() do processo NÃO reflete mais sábado sob esse TZ");
      assert.notEqual(SABADO_14H_SP.getHours(), 14, "sanity: getHours() do processo NÃO reflete mais 14h sob esse TZ");

      // mas foraDeExpediente() usa Intl.DateTimeFormat com timeZone fixo — o
      // resultado tem que continuar correto independente do TZ do processo.
      assert.equal(await foraDeExpediente(SABADO_14H_SP), true, "sábado 14h em SP continua fora de expediente");
      assert.equal(await foraDeExpediente(TERCA_10H_SP), false, "terça 10h em SP continua dentro do expediente");
    } finally {
      if (tzOriginal === undefined) delete process.env.TZ;
      else process.env.TZ = tzOriginal;
    }
  }
);

// ── Formatação dinâmica dos dias (usada na mensagem da saudação) ───────────
// (não toca banco — roda sempre, mesmo sem DATABASE_URL)
test("formatarDiasSemana: intervalo contíguo vira 'seg a sex'; não contíguo lista com 'e'", () => {
  assert.equal(formatarDiasSemana([1, 2, 3, 4, 5]), "seg a sex");
  assert.equal(formatarDiasSemana([1, 3, 5]), "seg, qua e sex");
  assert.equal(formatarDiasSemana([2]), "ter");
  assert.equal(formatarDiasSemana([0, 6]), "dom e sáb");
});

// ── PUT /admin/config: validação de horário ─────────────────────────────────

function tokenAdmin(app: Awaited<ReturnType<typeof montarApp>>): string {
  return app.jwt.sign({ sub: "teste", email: "teste@teste.local", nome: "Teste", role: "admin" });
}

// Cenário: PUT rejeita horário malformado
test("PUT /admin/config rejeita horaInicio malformado (400) e não persiste", { skip: SEM_BANCO }, async () => {
  await setConfig({ horarioAtivo: false, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
  const app = await montarApp();
  const token = tokenAdmin(app);

  const res = await app.inject({
    method: "PUT",
    url: "/admin/config",
    headers: { authorization: `Bearer ${token}` },
    payload: { horaInicio: "9h", horarioAtivo: true },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  const depois = await db!.config.findUnique({ where: { id: "default" } });
  assert.equal(depois?.horaInicio, "09:00", "horaInicio inválido não deve ter sido persistido");
  assert.equal(depois?.horarioAtivo, false, "campo válido do mesmo payload também não deve persistir (tudo ou nada)");
});

// Cenário: PUT rejeita janela invertida
test("PUT /admin/config rejeita horaFim <= horaInicio (400) e não persiste", { skip: SEM_BANCO }, async () => {
  await setConfig({ horarioAtivo: false, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
  const app = await montarApp();
  const token = tokenAdmin(app);

  const res = await app.inject({
    method: "PUT",
    url: "/admin/config",
    headers: { authorization: `Bearer ${token}` },
    payload: { horaInicio: "18:00", horaFim: "09:00" },
  });
  await app.close();

  assert.equal(res.statusCode, 400);
  const depois = await db!.config.findUnique({ where: { id: "default" } });
  assert.equal(depois?.horaInicio, "09:00");
  assert.equal(depois?.horaFim, "18:00");
});

test(
  "PUT /admin/config rejeita diasSemana com valor fora de 0-6 ou duplicado (400) e não persiste",
  { skip: SEM_BANCO },
  async () => {
    await setConfig({ horarioAtivo: false, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
    const app = await montarApp();
    const token = tokenAdmin(app);

    const foraDoRange = await app.inject({
      method: "PUT",
      url: "/admin/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { diasSemana: [1, 2, 7] },
    });
    assert.equal(foraDoRange.statusCode, 400);

    const duplicado = await app.inject({
      method: "PUT",
      url: "/admin/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { diasSemana: [1, 1, 2] },
    });
    assert.equal(duplicado.statusCode, 400);
    await app.close();

    const depois = await db!.config.findUnique({ where: { id: "default" } });
    assert.deepEqual(depois?.diasSemana, [1, 2, 3, 4, 5], "diasSemana inválido não deve ter sido persistido");
  }
);

test("PUT /admin/config aceita e persiste os 4 campos válidos; GET devolve o mesmo valor", { skip: SEM_BANCO }, async () => {
  await setConfig({ horarioAtivo: false, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
  const app = await montarApp();
  const token = tokenAdmin(app);

  const put = await app.inject({
    method: "PUT",
    url: "/admin/config",
    headers: { authorization: `Bearer ${token}` },
    payload: { horarioAtivo: true, diasSemana: [1, 2, 3, 4, 5, 6], horaInicio: "08:30", horaFim: "19:00" },
  });
  assert.equal(put.statusCode, 200);

  const get = await app.inject({ method: "GET", url: "/admin/config", headers: { authorization: `Bearer ${token}` } });
  await app.close();

  assert.equal(get.statusCode, 200);
  const corpo = get.json();
  assert.equal(corpo.horarioAtivo, true);
  assert.deepEqual(corpo.diasSemana, [1, 2, 3, 4, 5, 6]);
  assert.equal(corpo.horaInicio, "08:30");
  assert.equal(corpo.horaFim, "19:00");
});

after(async () => {
  if (!db) return; // modo sem banco: nada foi tocado, nada a limpar
  // devolve a config ao estado padrão pra não vazar estado entre execuções locais
  await setConfig({ horarioAtivo: false, diasSemana: [1, 2, 3, 4, 5], horaInicio: "09:00", horaFim: "18:00" });
  await db.$disconnect();
});
