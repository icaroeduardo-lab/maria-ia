-- CreateTable
CREATE TABLE "PlantaoVigente" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "municipio" TEXT NOT NULL,
    "nomeOrgao" TEXT NOT NULL,
    "telefone" TEXT,
    "endereco" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlantaoVigente_pkey" PRIMARY KEY ("id")
);
