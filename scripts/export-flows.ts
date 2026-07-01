import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

// Exporta os flows do banco (fonte viva, editada pelo painel) para
// prisma/flows.seed.json — mantém o git como backup/fonte única e evita drift
// entre o que roda na produção e o que está versionado.
//
//   pnpm flows:export                 → usa DATABASE_URL do ambiente
//   DATABASE_URL=... pnpm flows:export → aponta para outro banco (ex: RDS)

const __dirname = dirname(fileURLToPath(import.meta.url));
const destino = join(__dirname, "../prisma/flows.seed.json");

const prisma = new PrismaClient();

const flows = await prisma.flow.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
const seed = flows.map((f) => ({
  id: f.id,
  name: f.name,
  active: f.active,
  nodes: f.nodes,
  edges: f.edges,
}));

writeFileSync(destino, JSON.stringify(seed, null, 2) + "\n");
console.log(`[export] ${seed.length} flow(s) → prisma/flows.seed.json`);
for (const f of seed) console.log(`  - ${f.active ? "●" : "○"} ${f.name} (${f.id})`);

await prisma.$disconnect();
