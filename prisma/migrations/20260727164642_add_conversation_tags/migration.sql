-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
