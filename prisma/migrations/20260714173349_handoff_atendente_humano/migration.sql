-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "handoffDesde" TIMESTAMP(3),
ADD COLUMN     "handoffOperador" TEXT,
ADD COLUMN     "handoffStatus" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_handoffStatus_idx" ON "Conversation"("handoffStatus");
