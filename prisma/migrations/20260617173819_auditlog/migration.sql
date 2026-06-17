-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "acao" TEXT NOT NULL,
    "alvoTipo" TEXT NOT NULL,
    "alvoId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_criadoEm_idx" ON "AuditLog"("criadoEm");

