import { PrismaClient } from "@prisma/client";

// null quando DATABASE_URL não está configurada — engine continua funcionando
// (checkpoints em SQLite, sem tracking/admin). Admin API exige Postgres.
export const prisma: PrismaClient | null = process.env.DATABASE_URL ? new PrismaClient() : null;
