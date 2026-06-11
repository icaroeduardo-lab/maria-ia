-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "orgId" TEXT NOT NULL DEFAULT 'dperj';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "limiteConversasMes" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "plano" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "waAccessToken" TEXT,
ADD COLUMN     "waPhoneNumberId" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_orgId_startedAt_idx" ON "Conversation"("orgId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_waPhoneNumberId_key" ON "Organization"("waPhoneNumberId");


-- backfill: org existente ganha slug = id (seed usa id "dperj")
UPDATE "Organization" SET "slug" = "id" WHERE "slug" IS NULL;
ALTER TABLE "Organization" ALTER COLUMN "slug" SET NOT NULL;
