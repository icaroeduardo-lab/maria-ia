import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Issue #196 — achado ao vivo 2026-08-13, testando com PDF real (CNH-e do
// governo): o Bedrock (Converse API), lendo o PDF via bloco `document` cru,
// leu 2 dígitos do CPF errados de forma DETERMINÍSTICA (mesmo documento,
// mesma chamada, resultado sempre igual — trocou dígitos por dígitos de um
// campo numérico vizinho no layout do documento). O documento é perfeitamente
// legível a olho nu (confirmado renderizando a 200dpi) — não é problema de
// qualidade do arquivo, é o bloco `document` do Converse processando o PDF
// de um jeito menos confiável que uma imagem rasterizada. Rasterizando a
// mesma página como PNG a 300dpi e mandando como bloco `image`, a extração
// (nome, CPF, data de nascimento) veio correta em 3/3 execuções repetidas —
// a 200dpi o resultado ainda variava entre execuções, só 300dpi foi estável.
// Por isso `extrairDadosDocumento` (ocr-documento.ts) rasteriza PDF antes de
// mandar pro Bedrock; imagem (jpeg/png) enviada direto não passa por aqui.
//
// Usa o binário `pdftoppm` (poppler-utils) via child_process em vez de uma
// lib npm de rasterização: `sharp` (já dependência do projeto) não tem
// suporte a PDF no build instalado (testado ao vivo — "Input buffer contains
// unsupported image format"), e libs puramente JS de rasterização de PDF
// trazem binários nativos própios de qualquer forma. `pdftoppm` é leve,
// determinístico e já testado contra o documento real. Precisa estar
// instalado no ambiente (`apk add poppler-utils` no Dockerfile.api, `apt-get
// install poppler-utils` no CI — ver ci.yml). Dev local: instalar via
// gerenciador de pacote do SO (`apt install poppler-utils` / `brew install
// poppler`) — sem o binário, esta função lança erro claro em vez de falhar
// silencioso.
export async function renderizarPrimeiraPaginaComoPng(pdfBuffer: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "maria-pdf-"));
  const entrada = join(dir, "documento.pdf");
  const saidaBase = join(dir, "pagina");
  try {
    await writeFile(entrada, pdfBuffer);
    try {
      await execFileAsync("pdftoppm", [
        "-png",
        "-r",
        "300",
        "-singlefile",
        "-f",
        "1",
        "-l",
        "1",
        entrada,
        saidaBase,
      ]);
    } catch (err) {
      throw new Error(
        `pdftoppm falhou ao rasterizar o PDF (binário poppler-utils ausente ou PDF inválido): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return await readFile(`${saidaBase}.png`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
