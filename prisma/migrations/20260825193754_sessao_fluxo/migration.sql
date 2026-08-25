-- CreateTable
CREATE TABLE "SessaoFluxo" (
    "sessionId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessaoFluxo_pkey" PRIMARY KEY ("sessionId")
);
