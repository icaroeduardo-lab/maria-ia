-- CreateTable
CREATE TABLE "PessoaPresa" (
    "id" TEXT NOT NULL,
    "rg" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "situacao" TEXT NOT NULL,
    "tipoPreso" TEXT NOT NULL,
    "regime" TEXT,
    "idPessoa" TEXT NOT NULL,
    "idSeap" TEXT NOT NULL,
    "orgaoPreso" JSONB,
    "orgaoLiberto" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PessoaPresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasoPessoaPresa" (
    "id" TEXT NOT NULL,
    "identificador" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "pessoaPresaId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasoPessoaPresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessoPessoaPresa" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "origem" TEXT NOT NULL,
    "idProcesso" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessoPessoaPresa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PessoaPresa_rg_key" ON "PessoaPresa"("rg");

-- CreateIndex
CREATE UNIQUE INDEX "PessoaPresa_idPessoa_key" ON "PessoaPresa"("idPessoa");

-- CreateIndex
CREATE UNIQUE INDEX "PessoaPresa_idSeap_key" ON "PessoaPresa"("idSeap");

-- CreateIndex
CREATE INDEX "CasoPessoaPresa_pessoaPresaId_status_idx" ON "CasoPessoaPresa"("pessoaPresaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessoPessoaPresa_numero_key" ON "ProcessoPessoaPresa"("numero");

-- AddForeignKey
ALTER TABLE "CasoPessoaPresa" ADD CONSTRAINT "CasoPessoaPresa_pessoaPresaId_fkey" FOREIGN KEY ("pessoaPresaId") REFERENCES "PessoaPresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
