-- CreateTable
CREATE TABLE "NodeVisita" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeVisita_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NodeVisita_flowId_idx" ON "NodeVisita"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeVisita_flowId_nodeId_key" ON "NodeVisita"("flowId", "nodeId");
