import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Cria admin, assistidos de exemplo, casos e os FLUXOS (do flows.seed.json),
// deixando o "Fluxo DPERJ Completo" ativo. Banco novo nasce pronto.
// Rodar: pnpm seed   (senha via SEED_ADMIN_PASSWORD, default "admin123" — trocar em produção)

const prisma = new PrismaClient();
const __dirname = dirname(fileURLToPath(import.meta.url));

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@mariachat.local";
const senha = process.env.SEED_ADMIN_PASSWORD ?? "admin123";

await prisma.user.upsert({
  where: { email },
  update: { role: "admin" },
  create: {
    email,
    senha: bcrypt.hashSync(senha, 10),
    nome: "Administrador",
    role: "admin",
  },
});

// Assistido de exemplo (CPF 000.000.000-00) — usado nos testes de fluxo
const joao = await prisma.assistido.upsert({
  where: { cpf: "00000000000" },
  update: {},
  create: {
    cpf: "00000000000",
    nome: "João da Silva Santos",
    dataNascimento: "1985-03-22",
    nomeMae: "Maria Aparecida da Silva",
    situacao: "regular",
    municipio: "Rio de Janeiro",
    uf: "RJ",
    telefone: "21999990000",
    email: "joao.silva@example.com",
  },
});

// Casos em aberto de exemplo (só cria se ainda não houver)
if ((await prisma.caso.count({ where: { assistidoId: joao.id } })) === 0) {
  await prisma.caso.createMany({
    data: [
      { assistidoId: joao.id, identificador: "0801234-56.2025.8.19.0001", tipo: "Pensão alimentícia", status: "aberto" },
      { assistidoId: joao.id, identificador: "0809876-54.2025.8.19.0001", tipo: "Divórcio", status: "aberto" },
    ],
  });
}

// Maria — cadastrada, SEM casos em aberto (testar o caminho "outro assunto")
await prisma.assistido.upsert({
  where: { cpf: "11144477735" },
  update: {},
  create: {
    cpf: "11144477735",
    nome: "Maria Oliveira Costa",
    dataNascimento: "1990-07-15",
    nomeMae: "Joana Oliveira Costa",
    situacao: "regular",
    municipio: "Niterói",
    uf: "RJ",
    telefone: "21988887766",
    email: "maria.costa@example.com",
  },
});

// Carlos — cadastrado, COM 1 caso em aberto
const carlos = await prisma.assistido.upsert({
  where: { cpf: "52998224725" },
  update: {},
  create: {
    cpf: "52998224725",
    nome: "Carlos Pereira Lima",
    dataNascimento: "1978-11-02",
    nomeMae: "Antônia Pereira Lima",
    situacao: "regular",
    municipio: "Duque de Caxias",
    uf: "RJ",
    telefone: "21977776655",
    email: "carlos.lima@example.com",
  },
});
if ((await prisma.caso.count({ where: { assistidoId: carlos.id } })) === 0) {
  await prisma.caso.create({
    data: { assistidoId: carlos.id, identificador: "0805555-11.2025.8.19.0021", tipo: "Aposentadoria (INSS)", status: "aberto" },
  });
}

// Fluxos (exportados em flows.seed.json) — upsert por id preserva refs de subfluxo
interface FlowSeed { id: string; name: string; active: boolean; nodes: object[]; edges: object[] }
const flows = JSON.parse(readFileSync(join(__dirname, "flows.seed.json"), "utf-8")) as FlowSeed[];
for (const f of flows) {
  await prisma.flow.upsert({
    where: { id: f.id },
    update: { name: f.name, active: f.active, nodes: f.nodes, edges: f.edges },
    create: { id: f.id, name: f.name, active: f.active, nodes: f.nodes, edges: f.edges },
  });
}

// Catálogo de templates (card #20260127) — ids fixos, upsert idempotente.
// isTemplate:true → aparecem no catálogo "+ De template" do painel; nunca
// ativados nem usados como fluxo de atendimento real.
const TEMPLATES: FlowSeed[] = [
  {
    id: "template-coleta-dados-pessoais",
    name: "Template: Coleta de dados pessoais",
    active: false,
    nodes: [
      { id: "t_nome", type: "pergunta", data: { chave: "nome", texto: "Qual o seu nome completo?", semReescrita: true, tipoPergunta: "texto" }, position: { x: 0, y: 0 } },
      { id: "t_cpf", type: "pergunta", data: { chave: "cpf", texto: "Qual o seu CPF (somente números)?", semReescrita: true, tipoPergunta: "cpf" }, position: { x: 300, y: 0 } },
      { id: "t_telefone", type: "pergunta", data: { chave: "telefone", texto: "Qual o seu telefone com DDD?", semReescrita: true, tipoPergunta: "telefone" }, position: { x: 600, y: 0 } },
      { id: "t_fim", type: "encerrar", data: {}, position: { x: 900, y: 0 } },
    ],
    edges: [
      { id: "te1", source: "t_nome", target: "t_cpf" },
      { id: "te2", source: "t_cpf", target: "t_telefone" },
      { id: "te3", source: "t_telefone", target: "t_fim" },
    ],
  },
  {
    id: "template-confirmacao-sim-nao",
    name: "Template: Confirmação sim/não com 2 saídas",
    active: false,
    nodes: [
      { id: "t_confirma", type: "pergunta", data: { chave: "confirma", texto: "Você confirma?", semReescrita: true, tipoPergunta: "sim_nao" }, position: { x: 0, y: 0 } },
      { id: "t_sim", type: "mensagem", data: { texto: "Confirmado! Vamos seguir." }, position: { x: 300, y: -80 } },
      { id: "t_nao", type: "mensagem", data: { texto: "Tudo bem, sem problemas." }, position: { x: 300, y: 80 } },
    ],
    edges: [
      { id: "tc1", source: "t_confirma", target: "t_sim", label: "true" },
      { id: "tc2", source: "t_confirma", target: "t_nao", label: "false" },
    ],
  },
];
for (const t of TEMPLATES) {
  await prisma.flow.upsert({
    where: { id: t.id },
    update: { name: t.name, nodes: t.nodes, edges: t.edges, isTemplate: true },
    create: { id: t.id, name: t.name, active: false, isTemplate: true, nodes: t.nodes, edges: t.edges },
  });
}

console.log(`Seed ok — admin ${email}; ${flows.length} fluxos; ${TEMPLATES.length} templates; assistidos: 00000000000 (2 casos), 11144477735 (Maria, s/ casos), 52998224725 (Carlos, 1 caso)`);
await prisma.$disconnect();
