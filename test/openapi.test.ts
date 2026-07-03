import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { montarApp } from "../src/api/app.js";

// Guard de sincronia: toda rota registrada no Fastify precisa estar documentada
// em docs/openapi.yaml (que é a documentação oficial servida em /docs) — e
// vice-versa (spec não pode apontar rota que não existe mais).

// rotas de infraestrutura que não entram na doc da API
const IGNORAR = [
  /^\/docs(\/|$)/, // swagger-ui (auto-registradas)
  /^\/\*$/, // wildcard do fastify-static (arquivos de public/)
  /^\/$/, // raiz (index.html do chat web)
];
const METODOS_IGNORADOS = new Set(["HEAD", "OPTIONS"]);

// Fastify usa :param; OpenAPI usa {param}
const normalizar = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

async function rotasDoApp(): Promise<Set<string>> {
  const rotas = new Set<string>();
  const app = await montarApp({
    aoRegistrarRota: (method, url) => {
      if (METODOS_IGNORADOS.has(method)) return;
      if (IGNORAR.some((re) => re.test(url))) return;
      rotas.add(`${method.toUpperCase()} ${normalizar(url)}`);
    },
  });
  await app.ready();
  await app.close();
  return rotas;
}

function rotasDoSpec(): Set<string> {
  const spec = parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
  const rotas = new Set<string>();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const metodo of Object.keys(ops as object)) {
      if (["get", "post", "put", "patch", "delete"].includes(metodo)) {
        rotas.add(`${metodo.toUpperCase()} ${path}`);
      }
    }
  }
  return rotas;
}

test("toda rota do Fastify está documentada no openapi.yaml", async () => {
  const app = await rotasDoApp();
  const spec = rotasDoSpec();
  const naoDocumentadas = [...app].filter((r) => !spec.has(r)).sort();
  assert.deepEqual(
    naoDocumentadas,
    [],
    `rotas sem documentação em docs/openapi.yaml (adicione lá):\n${naoDocumentadas.join("\n")}`
  );
});

test("toda rota do openapi.yaml existe no Fastify (spec não está obsoleta)", async () => {
  const app = await rotasDoApp();
  const spec = rotasDoSpec();
  const obsoletas = [...spec].filter((r) => !app.has(r)).sort();
  assert.deepEqual(
    obsoletas,
    [],
    `rotas documentadas que não existem mais no código (remova do yaml):\n${obsoletas.join("\n")}`
  );
});
