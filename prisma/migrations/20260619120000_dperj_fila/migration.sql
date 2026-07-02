-- CreateTable
CREATE TABLE "DperjFila" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "ultimoErro" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DperjFila_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DperjFila_criadoEm_idx" ON "DperjFila"("criadoEm");
