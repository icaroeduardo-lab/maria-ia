// Issue #196 — rasterização de PDF antes do OCR (ver src/core/pdf-render.ts
// e o comentário em src/core/ocr-documento.ts#extrairDadosDocumento).
// Puro/local (child_process do pdftoppm, sem tocar S3/Bedrock) — precisa do
// binário poppler-utils no PATH (Dockerfile.api e ci.yml instalam; dev local
// precisa instalar via gerenciador de pacote do SO).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderizarPrimeiraPaginaComoPng } from "../src/core/pdf-render.js";

// PDF mínimo válido (1 página em branco, 200x200pt) — poppler faz parsing
// tolerante mesmo sem xref table completa. Não precisa de texto/imagem real:
// só exercita a plumbing de rasterização (spawn, arquivo temp, leitura do
// PNG de volta), não a qualidade de leitura (isso já foi validado ao vivo
// contra documento real, ver comentário de pdf-render.ts).
const PDF_MINIMO = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>endobj",
    "trailer<</Root 1 0 R/Size 4>>",
    "%%EOF",
  ].join("\n"),
  "utf8"
);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("renderizarPrimeiraPaginaComoPng: PDF válido vira PNG (magic bytes corretos)", async () => {
  const png = await renderizarPrimeiraPaginaComoPng(PDF_MINIMO);
  assert.ok(png.length > 0, "PNG não pode vir vazio");
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC, "deve começar com a assinatura PNG");
});

test("renderizarPrimeiraPaginaComoPng: bytes que não são PDF lançam erro claro (não falha silenciosa)", async () => {
  const lixo = Buffer.from("isto não é um PDF de jeito nenhum", "utf8");
  await assert.rejects(
    () => renderizarPrimeiraPaginaComoPng(lixo),
    (err: Error) => {
      assert.match(err.message, /pdftoppm falhou/);
      return true;
    }
  );
});
