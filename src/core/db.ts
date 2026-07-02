import { PrismaClient } from "@prisma/client";
import { env } from "./env.js";

// null quando DATABASE_URL não está configurada — engine continua funcionando
// (checkpoints em SQLite, sem tracking/admin). Admin API exige Postgres.
export const prisma: PrismaClient | null = env.databaseUrl() ? new PrismaClient() : null;
