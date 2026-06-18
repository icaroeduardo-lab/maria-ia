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

console.log(`Seed ok — admin ${email}; ${flows.length} fluxos; assistidos: 00000000000 (2 casos), 11144477735 (Maria, s/ casos), 52998224725 (Carlos, 1 caso)`);
await prisma.$disconnect();
