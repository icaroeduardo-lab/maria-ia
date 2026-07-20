-- CreateTable
CREATE TABLE "RecessoVigente" (
    "id" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT false,
    "mensagem" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecessoVigente_pkey" PRIMARY KEY ("id")
);
