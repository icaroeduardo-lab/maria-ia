-- CreateTable
CREATE TABLE "Caso" (
    "id" TEXT NOT NULL,
    "identificador" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'aberto',
    "assistidoId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Caso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Caso_assistidoId_status_idx" ON "Caso"("assistidoId", "status");

-- AddForeignKey
ALTER TABLE "Caso" ADD CONSTRAINT "Caso_assistidoId_fkey" FOREIGN KEY ("assistidoId") REFERENCES "Assistido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

