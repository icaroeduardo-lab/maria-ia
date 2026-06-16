-- CreateTable
CREATE TABLE "Assistido" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'dperj',
    "cpf" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "dataNascimento" TEXT,
    "nomeMae" TEXT,
    "situacao" TEXT NOT NULL DEFAULT 'regular',
    "municipio" TEXT,
    "uf" TEXT,
    "telefone" TEXT,
    "email" TEXT,
    "cep" TEXT,
    "bairro" TEXT,
    "logradouro" TEXT,
    "numero" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assistido_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Assistido_orgId_idx" ON "Assistido"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Assistido_orgId_cpf_key" ON "Assistido"("orgId", "cpf");

