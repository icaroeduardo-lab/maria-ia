import "dotenv/config";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { classificarTexto, retriever } from "../src/core/engine/ia.js";

// Eval set do node "classificar" do Orquestrador (fluxo MariaIA, node
// no_w6owdo) — mede acerto de categoria contra uma lista de relatos com
// gabarito conhecido. Roda os relatos de eval-casos-classificar.csv contra
// o classificador REAL (Bedrock + RAG, mesmo caminho de produção) e reporta
// acerto por categoria + os erros específicos, pra decisão de prompt/modelo
// deixar de ser "testei na mão e pareceu certo".
//
//   pnpm eval:classificar
//
// Categorias/prompt copiados do node no_w6owdo (Orquestrador, mcp-maria-flows)
// em 2026-08-10 — reaplicar aqui se o prompt do node mudar no painel.

const OPCOES = [
  "divórcio",
  "alimentação",
  "trabalhista",
  "pessoa_presa",
  "violencia_domestica",
  "falar_processo",
  "questoes_saude",
  "fora_competencia",
  "outros",
];

const PROMPT = `Você classifica o relato de um cidadão pra Defensoria Pública do RJ em UMA categoria, entre as opções abaixo. Leia o relato inteiro antes de decidir: a categoria é definida pelo que a pessoa está PEDINDO, não por palavras soltas como "filho" ou "marido".

REGRA DE OURO (divórcio vs. alimentação): 'alimentação' exige menção EXPLÍCITA a pensão, sustento financeiro ou dinheiro pra filho(s) (ex: "pensão", "alimentícia", "sustento", "não paga nada pro meu filho", "não ajuda financeiramente"). Um relato que fala em separação, divórcio, fim de casamento, união estável ou partilha de bens, SEM pedir pensão/dinheiro pro filho, NUNCA é 'alimentação' — é 'divórcio', mesmo que existam filhos ou um ex-cônjuge mencionados na história.

- divórcio: pedido de separação, fim de casamento ou união estável, dissolução do vínculo, partilha de bens — o pedido é sobre TERMINAR o relacionamento, não sobre dinheiro pros filhos.
  Exemplos QUE SÃO divórcio: "Quero me divorciar do meu marido" · "Quero entrar com pedido de divórcio, terminar meu casamento e dividir os bens com meu marido" · "Quero me separar da minha esposa".
- alimentação: PENSÃO ALIMENTÍCIA, sustento de filho(s), pai/mãe que não paga ou não ajuda financeiramente pelos filhos. O pedido é sobre DINHEIRO pros filhos.
  Exemplos QUE SÃO alimentação: "Preciso de pensão pro meu filho" · "Meu ex não passa pensão há 3 meses" · "Quero me separar do meu marido e também preciso que ele pague pensão pro nosso filho" (aqui as duas coisas aparecem juntas, mas como há pedido explícito de pensão, classifique como alimentação).
- trabalhista: demissão, verbas rescisórias, problemas com emprego/CLT.
- pessoa_presa: assistência jurídica pra pessoa presa/apenado — familiar buscando ajuda pra quem está preso, agendamento com órgão responsável, situação prisional. Palavras-chave: preso, presídio, cadeia, apenado, réu preso.
- violencia_domestica: violência física, psicológica, moral, patrimonial ou sexual sofrida por mulher, praticada por companheiro/ex-companheiro ou familiar. Palavras-chave: agressão, agressor, marido/companheiro batendo, medida protetiva, violência doméstica.
- falar_processo: cidadão quer saber sobre um processo/intimação QUE JÁ EXISTE (não é pedido novo) — quer acompanhar andamento, recebeu intimação, tem dúvida sobre processo específico. Palavras-chave: meu processo, número do processo, intimação, andamento, acompanhar processo.
- questoes_saude: pedidos relacionados a saúde — acesso a tratamento/medicamento pelo SUS, internação, plano de saúde, negativa de procedimento médico. Palavras-chave: saúde, médico, hospital, SUS, tratamento, medicamento, plano de saúde.
- fora_competencia: matéria criminal SEM réu preso ou questões claramente fora da Defensoria.
- outros: qualquer outro assunto cível.`;

interface Caso {
  relato: string;
  esperado: string;
}

function carregarCasos(): Caso[] {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const caminho = join(__dirname, "eval-casos-classificar.csv");
  const linhas = readFileSync(caminho, "utf-8").trim().split("\n").slice(1); // pula cabeçalho
  return linhas.map((linha) => {
    const i = linha.lastIndexOf(",");
    return { relato: linha.slice(0, i).trim(), esperado: linha.slice(i + 1).trim() };
  });
}

async function contextoRagPara(relato: string): Promise<string | undefined> {
  if (!retriever) return undefined;
  try {
    const docs = await retriever.invoke(relato);
    return docs
      .map((d) => d.pageContent)
      .join("\n\n")
      .slice(0, 4000);
  } catch {
    return undefined;
  }
}

async function main() {
  const casos = carregarCasos();
  console.log(
    `[eval] ${casos.length} caso(s), modelo=${process.env.BEDROCK_MODEL_ID ?? "(padrão)"}, rag=${retriever ? "on" : "off"}\n`
  );

  let acertos = 0;
  const erros: { relato: string; esperado: string; obtido: string }[] = [];
  const porCategoria = new Map<string, { total: number; acertos: number }>();

  for (const { relato, esperado } of casos) {
    const contextoRag = await contextoRagPara(relato);
    const obtido = await classificarTexto(relato, OPCOES, PROMPT, contextoRag);
    const acertou = obtido.toLowerCase() === esperado.toLowerCase();

    const stat = porCategoria.get(esperado) ?? { total: 0, acertos: 0 };
    stat.total += 1;
    if (acertou) stat.acertos += 1;
    porCategoria.set(esperado, stat);

    if (acertou) {
      acertos += 1;
      console.log(`  ✅ "${relato}" → ${obtido}`);
    } else {
      erros.push({ relato, esperado, obtido });
      console.log(`  ❌ "${relato}" → esperado "${esperado}", veio "${obtido}"`);
    }
  }

  console.log(
    `\n[eval] acerto geral: ${acertos}/${casos.length} (${((acertos / casos.length) * 100).toFixed(1)}%)\n`
  );
  console.log("[eval] acerto por categoria:");
  for (const [cat, stat] of [...porCategoria.entries()].sort()) {
    const pct = ((stat.acertos / stat.total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(20)} ${stat.acertos}/${stat.total} (${pct}%)`);
  }

  if (erros.length) {
    console.log("\n[eval] erros pra investigar:");
    for (const e of erros) console.log(`  - "${e.relato}" → esperado "${e.esperado}", veio "${e.obtido}"`);
  }

  // saída forçada — conexão do Redis (cache.ts, importado por ia.ts pra
  // reescreverPergunta) fica aberta e o processo nunca sai sozinho, mesmo
  // motivo do --test-force-exit já usado em `pnpm test`.
  process.exit(erros.length ? 1 : 0);
}

main();
