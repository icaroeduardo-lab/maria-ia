import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Cria o usuário admin inicial e um assistido de exemplo.
// Rodar: pnpm seed   (senha via SEED_ADMIN_PASSWORD, default "admin123" — trocar em produção)

const prisma = new PrismaClient();

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
await prisma.assistido.upsert({
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

console.log(`Seed ok — admin ${email}, assistido CPF 00000000000`);
await prisma.$disconnect();
