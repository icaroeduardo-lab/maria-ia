import type { FastifyInstance } from "fastify";
import { classificarTexto, retriever } from "../../../core/engine/ia.js";

// SEM AUTENTICAÇÃO (protótipo/temporário da integração Maria↔Tykhe) — mesmo racional de assistidos.ts/mensagem.ts (ver ali); não subir pra produção sem token.

// Categorias + prompt REPLICADOS do node "classificar" (id no_w6owdo) do fluxo
// real "Orquestrador" (flow cmrks4fs50006md0jtkhth1kw, conferido via
// mcp-maria-flows obter_fluxo em 2026-08-24) — não inventados aqui. O fluxo no
// banco é a fonte da verdade (ver CLAUDE.md raiz, "Fluxos de atendimento vivem
// no banco"); se o prompt/opções mudarem lá, replicar manualmente aqui — este
// endpoint roda FORA do grafo (chamada direta, sem estado/sessão/multi-turn),
// então não há como reusar o node compilado do builder sem rodar o fluxo
// inteiro (que pararia na saudação/LGPD antes de classificar qualquer coisa).
const OPCOES_CATEGORIA = [
  "divórcio",
  "alimentação",
  "trabalhista",
  "pessoa_presa",
  "violencia_domestica",
  "falar_processo",
  "questoes_saude",
  "fora_competencia",
  "outros",
] as const;

const PROMPT_CLASSIFICACAO = `Você classifica o relato de um cidadão pra Defensoria Pública do RJ em UMA categoria, entre as opções abaixo. Leia o relato inteiro antes de decidir: a categoria é definida pelo que a pessoa está PEDINDO, não por palavras soltas como "filho" ou "marido".

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

export async function tykheIdentificarFluxoRoutes(app: FastifyInstance) {
  // POST /api/tykhe/identificar-fluxo — { relato } → { categoria }
  //
  // Fatia BEM menor que /api/tykhe/mensagem: só identifica a categoria/fluxo
  // de um relato livre, sem rodar o motor conversacional (sem saudação, LGPD,
  // multi-turn, envio de dados...). Reusa a MESMA função de classificação que
  // o engine chama pro node tipo "classificar" (classificarTexto, em
  // core/engine/ia.ts — já isolada do grafo, sem checkpoint/thread_id/estado),
  // com o mesmo prompt+RAG que o node "classificar" do fluxo Orquestrador usa
  // (usarRag: true lá — ver constantes acima). Sem Bedrock disponível,
  // classificarTexto já degrada sozinha pro matcher por palavra-chave (mesmo
  // contrato usado no resto do engine, ver CLAUDE.md "Fallbacks de IA").
  app.post("/api/tykhe/identificar-fluxo", async (req, reply) => {
    const body = (req.body ?? {}) as { relato?: string };
    const relato = typeof body.relato === "string" ? body.relato.trim() : "";
    if (!relato) return reply.code(400).send({ erro: "relato obrigatório" });

    let contextoRag: string | undefined;
    if (retriever) {
      try {
        const docs = await retriever.invoke(relato);
        contextoRag = docs
          .map((d) => d.pageContent)
          .join("\n\n")
          .slice(0, 4000);
      } catch (err) {
        console.warn("[tykhe] RAG indisponível ao identificar fluxo:", String(err).slice(0, 100));
      }
    }

    const categoria = await classificarTexto(
      relato,
      [...OPCOES_CATEGORIA],
      PROMPT_CLASSIFICACAO,
      contextoRag
    );
    return { categoria };
  });
}
