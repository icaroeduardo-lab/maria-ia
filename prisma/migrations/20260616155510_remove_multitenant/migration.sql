-- DropForeignKey
ALTER TABLE "Flow" DROP CONSTRAINT "Flow_orgId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_orgId_fkey";

-- DropIndex
DROP INDEX "Assistido_orgId_cpf_key";

-- DropIndex
DROP INDEX "Assistido_orgId_idx";

-- DropIndex
DROP INDEX "Conversation_orgId_startedAt_idx";

-- AlterTable
ALTER TABLE "Assistido" DROP COLUMN "orgId";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "orgId";

-- AlterTable
ALTER TABLE "Flow" DROP COLUMN "orgId";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "orgId";

-- DropTable
DROP TABLE "Organization";

-- CreateIndex
CREATE UNIQUE INDEX "Assistido_cpf_key" ON "Assistido"("cpf");

-- CreateIndex
CREATE INDEX "Conversation_startedAt_idx" ON "Conversation"("startedAt");

