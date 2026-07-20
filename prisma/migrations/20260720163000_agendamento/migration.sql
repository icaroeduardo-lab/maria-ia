-- CreateTable
CREATE TABLE "Agendamento" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "local" TEXT,
    "status" TEXT NOT NULL DEFAULT 'aberto',
    "assistidoId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agendamento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agendamento_assistidoId_status_idx" ON "Agendamento"("assistidoId", "status");

-- AddForeignKey
ALTER TABLE "Agendamento" ADD CONSTRAINT "Agendamento_assistidoId_fkey" FOREIGN KEY ("assistidoId") REFERENCES "Assistido"("id") ON DELETE CASCADE ON UPDATE CASCADE;
