import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Cria a organização DPERJ e o usuário admin inicial.
// Rodar: pnpm seed   (senha via SEED_ADMIN_PASSWORD, default "admin123" — trocar em produção)

const prisma = new PrismaClient();

const org = await prisma.organization.upsert({
  where: { id: "dperj" },
  update: { slug: "dperj" },
  create: {
    id: "dperj",
    slug: "dperj",
    name: "Defensoria Pública do Estado do Rio de Janeiro",
    plano: "enterprise",
    limiteConversasMes: 0, // 0 = ilimitado
  },
});

const email = process.env.SEED_ADMIN_EMAIL ?? "admin@mariachat.local";
const senha = process.env.SEED_ADMIN_PASSWORD ?? "admin123";

await prisma.user.upsert({
  where: { email },
  update: { role: "superadmin" },
  create: {
    email,
    senha: bcrypt.hashSync(senha, 10),
    nome: "Administrador",
    role: "superadmin", // superadmin gerencia organizações (multi-tenant)
    orgId: org.id,
  },
});

console.log(`Seed ok — org "${org.name}", admin ${email}`);
await prisma.$disconnect();
