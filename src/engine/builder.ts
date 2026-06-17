import { StateGraph, END, START } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { ChatBedrockConverse } from "@langchain/aws";
import { AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { obterEstilo, obterConfig } from "../config.js";
import { GraphAnnotation, type GraphState } from "../state.js";
import { checkpointer, graph as graphEstatico } from "../graph.js";
import { mensagemPergunta, proxima, type Pergunta, type TipoPergunta } from "../perguntas.js";
import { extrator } from "../nodes/atendimento/extrator.js";
import { enviarDados } from "../nodes/atendimento/enviar-dados.js";
import { encerramento } from "../nodes/atendimento/encerramento.js";
import { servicoDe } from "../registro-perguntas.js";

// Compila um Flow (JSON criado no builder visual do painel admin) em um grafo
// LangGraph executável. Tipos de nó (espelho da paleta do React Flow):
//   mensagem | pergunta | condicao | ia | api | subgrafo | atribuir | encerrar

export interface FlowNode {
  id: string;
  type: "mensagem" | "pergunta" | "condicao" | "ia" | "classificar" | "api" | "subgrafo" | "subfluxo" | "atribuir" | "encerrar";
  position?: { x: number; y: number }; // usado só pelo frontend
  data: {
    label?: string;
    titulo?: string;           // identificação no canvas (api | condicao | classificar | subfluxo)
    texto?: string;            // mensagem | pergunta
    imagem?: string;           // mensagem (url)
    chave?: string;            // pergunta | api | atribuir | classificar (campo onde grava a categoria)
    tipoPergunta?: TipoPergunta;
    opcoes?: string[];         // pergunta(opcoes) | classificar (categorias possíveis)
    campo?: string;            // condicao: campo de dadosColetados a comparar
    prompt?: string;           // ia | classificar: instrução extra ao LLM
    usarRag?: boolean;         // ia
    url?: string;              // api
    metodo?: "GET" | "POST";   // api
    servico?: string;          // subgrafo: categoria (familia_pensao | trabalhista | ...)
    refFlowId?: string;        // subfluxo: id do Flow embutido (tema editável no painel)
    saida?: string;            // sub-flow: nomeia a saída deste nó-folha (casa com label da seta do subfluxo)
    semReescrita?: boolean;    // pergunta: não reescrever com IA (texto fixo — ex: LGPD/links)
    valor?: string;            // atribuir
  };
}

// Sub-flows referenciados por nós "subfluxo", indexados por id (carregados do banco)
export type SubflowMap = Record<string, { nodes: FlowNode[]; edges: FlowEdge[] }>;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string; // em edges saindo de condicao: valor esperado ("*" = default)
}

export interface FlowJSON {
  id: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const retriever = process.env.BEDROCK_KB_ID
  ? new AmazonKnowledgeBaseRetriever({
      topK: 3,
      knowledgeBaseId: process.env.BEDROCK_KB_ID,
      region: process.env.AWS_REGION ?? "us-east-1",
    })
  : null;

function ultimaFalaUsuario(state: GraphState): string {
  const m = state.messages.findLast((x) => x.getType() === "human");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : ""))
    .join(" ")
    .trim();
}

function perguntaDoNode(node: FlowNode): Pergunta {
  return {
    chave: node.data.chave ?? node.id,
    texto: node.data.texto ?? "",
    obrigatoria: true,
    tipo: node.data.tipoPergunta ?? "texto",
    opcoes: node.data.opcoes,
    imagem: node.data.imagem,
  };
}

// Resolve campo com suporte a notação de ponto e JSON aninhado.
// Ex: "resultado_cpf.encontrado" → parseia resultado_cpf como JSON e retorna .encontrado
function resolverCampo(dados: Record<string, unknown>, caminho: string): string {
  const partes = caminho.split(".");
  let valor: unknown = dados[partes[0]];

  if (typeof valor === "string" && partes.length > 1) {
    try { valor = JSON.parse(valor); } catch { return ""; }
  }

  for (let i = 1; i < partes.length; i++) {
    if (typeof valor !== "object" || valor === null) return "";
    valor = (valor as Record<string, unknown>)[partes[i]];
  }

  if (valor === undefined || valor === null) return "";
  if (typeof valor === "boolean") return String(valor);
  if (typeof valor === "object") return JSON.stringify(valor);
  return String(valor);
}

// versão para comparação em condições: lowercase + normaliza sim/não → true/false
function resolverCampoCondicao(dados: Record<string, unknown>, caminho: string): string {
  const v = resolverCampo(dados, caminho).toLowerCase().trim();
  if (v === "sim" || v === "s") return "true";
  if (v === "não" || v === "nao" || v === "n") return "false";
  return v;
}

// Classifica um texto livre em uma das categorias dadas. Tenta o LLM (Bedrock);
// se falhar (sem credenciais/rede), cai num matcher por palavra-chave.
// categoria padrão quando nada casa: "outros" se existir, senão a última
function categoriaPadrao(opcoes: string[]): string {
  return opcoes.find((o) => o.toLowerCase() === "outros") ?? opcoes[opcoes.length - 1];
}

async function classificarTexto(fala: string, opcoes: string[], prompt?: string, contextoRag?: string): Promise<string> {
  if (!opcoes.length) return "";
  if (!fala.trim()) return categoriaPadrao(opcoes); // sem relato → catch-all

  try {
    const instrucao =
      (prompt ?? "Você classifica o relato de um cidadão em uma categoria de serviço jurídico.") +
      (contextoRag ? `\n\n<base_de_conhecimento>\n${contextoRag}\n</base_de_conhecimento>` : "") +
      `\n\nCategorias possíveis (responda APENAS com uma delas, exatamente como escrita): ${opcoes.join(", ")}.`;
    const res = await model.invoke([
      new SystemMessage(instrucao),
      new HumanMessage(fala),
    ]);
    const bruto = String(res.content).toLowerCase().trim();
    const achou = opcoes.find((o) => bruto.includes(o.toLowerCase()));
    if (achou) return achou;
  } catch (err) {
    console.warn("[classificar] LLM indisponível, usando fallback por palavra-chave:", String(err).slice(0, 120));
  }

  return classificarPorPalavraChave(fala, opcoes);
}

// Fallback determinístico: mapeia palavras-chave → categoria.
const PALAVRAS_CHAVE: Record<string, string[]> = {
  alimentação: ["pensão", "pensao", "alimento", "sustento", "filho não", "mesada"],
  divórcio: ["divórcio", "divorcio", "separar", "separação", "casamento", "marido", "esposa", "cônjuge", "conjuge"],
  inss: ["inss", "aposentadoria", "aposentar", "benefício", "beneficio", "auxílio", "auxilio", "doença", "doenca", "loas", "bpc"],
  trabalhista: ["trabalho", "trabalhista", "demitido", "demissão", "rescisão", "salário", "carteira", "fgts", "emprego"],
  acompanhar: ["acompanhar", "andamento", "meu processo", "meu caso", "já tenho", "ja tenho", "protocolo"],
  fora_competencia: ["criminal", "preso", "prisão", "prisao", "empresa", "consumidor"],
};

function classificarPorPalavraChave(fala: string, opcoes: string[]): string {
  const txt = fala.toLowerCase();
  for (const opt of opcoes) {
    const chaves = PALAVRAS_CHAVE[opt.toLowerCase()] ?? [opt.toLowerCase()];
    if (chaves.some((k) => txt.includes(k))) return opt;
  }
  return categoriaPadrao(opcoes); // default → "outros" (não a última, que pode ser fora_competencia)
}

// ── Extração antecipada: a IA preenche o que o usuário já disse no relato ──────
const PLACEHOLDER = /unknown|n\/a|^null$|undefined|não informado|nao informado|<.+>|^[-?.]+$/i;
const normSimNao = (v: string) => {
  const s = v.trim().toLowerCase();
  if (s === "true" || s.startsWith("s")) return "sim";
  if (s === "false" || s.startsWith("n")) return "não";
  return v;
};
const casarOpcaoGen = (p: Pergunta, v: string) => {
  const t = v.trim().toLowerCase();
  return p.opcoes?.find((o) => o.toLowerCase() === t || o.toLowerCase().includes(t) || t.includes(o.toLowerCase()));
};

// Dado o relato livre, extrai valores para as perguntas ainda não respondidas.
// Só preenche o que foi dito EXPLICITAMENTE (guards anti-alucinação).
async function extrairDoRelato(
  relato: string,
  perguntas: Pergunta[],
  jaColetados: Record<string, unknown>
): Promise<Record<string, string>> {
  const pendentes = perguntas.filter((p) => p.texto && !(p.chave in jaColetados));
  if (!relato.trim() || !pendentes.length) return {};

  const shape: Record<string, z.ZodType> = {};
  for (const p of pendentes) {
    const desc = p.tipo === "opcoes" && p.opcoes?.length ? `${p.texto} (opções: ${p.opcoes.join(", ")})` : p.texto;
    shape[p.chave] = z.string().nullish().describe(desc);
  }

  try {
    const system = `Você extrai dados do relato de um cidadão (Defensoria Pública do RJ).
- Extraia APENAS o que foi dito EXPLICITAMENTE no relato. NUNCA deduza, suponha ou invente.
- Em dúvida, deixe null. Campos sim/não: só preencha se afirmado claramente, use "sim" ou "não".`;
    const out = await model.withStructuredOutput(z.object(shape)).invoke([
      new SystemMessage(system),
      new HumanMessage(`Relato: "${relato}"\n\nExtraia os dados informados (deixe null o que não foi dito).`),
    ]);

    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== "string" || !v.trim() || PLACEHOLDER.test(v.trim())) continue;
      const p = pendentes.find((x) => x.chave === k);
      if (!p) continue;
      // descarta quando o LLM ecoa o texto da própria pergunta como "valor"
      if (v.trim().toLowerCase() === p.texto.trim().toLowerCase()) continue;
      if (["true", "false"].includes(v.trim().toLowerCase()) && p.tipo !== "sim_nao") continue;
      if (p.tipo === "sim_nao") { const n = normSimNao(v); if (n === "sim" || n === "não") updates[k] = n; continue; }
      if (p.tipo === "opcoes") { const o = casarOpcaoGen(p, v); if (o) updates[k] = o; continue; }
      if (p.validar && !p.validar(v)) continue;
      updates[k] = v.trim();
    }
    if (Object.keys(updates).length) console.log(`[extrair] pré-preenchido: ${Object.keys(updates).join(", ")}`);
    return updates;
  } catch (err) {
    console.warn("[extrair] falha:", String(err).slice(0, 120));
    return {};
  }
}

// Reescreve a pergunta de forma curta, simples e acolhedora (conversacional),
// preservando exatamente o que está sendo pedido. Falha → texto original.
async function reescreverPergunta(
  textoBase: string,
  p: Pergunta,
  state: GraphState,
  estilo: string
): Promise<string> {
  try {
    const fala = ultimaFalaUsuario(state);
    // nome do assistido (cadastro existente ou novo) p/ tratamento pessoal
    const nomeCompleto = resolverCampo(state.dadosColetados, "resultado_cpf.dados.nome") || resolverCampo(state.dadosColetados, "nome");
    const primeiroNome = nomeCompleto.split(" ")[0];
    const regras = [
      "Você (Maria) está PERGUNTANDO ao cidadão para COLETAR uma informação. Reescreva a PERGUNTA abaixo de forma simples, calorosa e EMPÁTICA, como numa conversa real.",
      "Seja humano e acolhedor: demonstre que entende que pode ser um momento delicado e passe segurança de que você vai ajudar.",
      "VARIE bastante as aberturas. É PROIBIDO começar com 'Entendo' ou 'Entendi'. Use formas diferentes (ex: 'Certo', 'Obrigada', 'Pode deixar', 'Ótimo', 'Perfeito') ou vá direto à pergunta.",
      "NÃO repita nem parafraseie a resposta que a pessoa acabou de dar (você pode atribuir errado, ex: confundir o nome da outra parte com o dela). Apenas faça a próxima pergunta de forma calorosa.",
      "Use emojis com naturalidade e moderação (geralmente 1 por mensagem) para deixar a conversa leve e acolhedora — ex: 😊 🙏 💚 👍 📄.",
      "Não exagere na empatia: nem toda pergunta precisa de consolo.",
      "Formule como uma pergunta DIRETA pedindo o dado ao cidadão. NUNCA inverta (não diga que a pessoa quer saber algo).",
      "Mantenha EXATAMENTE a mesma informação pedida. Não acrescente nem troque por outra pergunta.",
      "No máximo 2 frases curtas. Não repita saudação (já cumprimentou).",
      "Preserve links, números, formatos (ex: CPF, datas) e termos legais exatamente como estão.",
      p.tipo === "sim_nao" ? "A pergunta deve poder ser respondida com Sim ou Não." : "",
      p.tipo === "opcoes" ? "NÃO liste as opções no texto (elas aparecem como botões)." : "",
    ].filter(Boolean).join("\n");

    const res = await model.invoke([
      new SystemMessage(`${estilo}\n\n${regras}`),
      new HumanMessage(
        `Pergunta a fazer: "${textoBase}"` +
        (primeiroNome ? `\nNome da pessoa: ${primeiroNome} (pode usar o nome com naturalidade, sem repetir toda vez)` : "") +
        (fala ? `\nÚltima fala da pessoa: "${fala}"` : "") +
        `\n\nResponda só com a pergunta reescrita.`
      ),
    ]);
    const txt = String(res.content).trim();
    return txt || textoBase;
  } catch (err) {
    console.warn("[conversacional] falha ao reescrever:", String(err).slice(0, 100));
    return textoBase;
  }
}

// interpola {{chave}} / {{chave.sub}} com dadosColetados — ex: "CPF: {{cpf}}"
function interpolar(txt: string, dados: Record<string, unknown>): string {
  return txt.replace(/\{\{([\w.]+)\}\}/g, (_, k) => resolverCampo(dados, k));
}

// base do próprio servidor para chamadas internas do fluxo (nós api com url relativa)
function baseUrlInterna(): string {
  return process.env.SELF_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

// ── Funções de nó ─────────────────────────────────────────────────────────────

// ctx.perguntas = todas as perguntas; ctx.perguntasPorCategoria = perguntas por tema (classify)
function criarNode(node: FlowNode, ctx?: { perguntas: Pergunta[]; perguntasPorCategoria?: Record<string, Pergunta[]> }) {
  switch (node.type) {
    case "mensagem":
      return async (state: GraphState) => {
        const blocos: object[] = [];
        if (node.data.imagem) blocos.push({ type: "image_url", image_url: { url: interpolar(String(node.data.imagem), state.dadosColetados) } });
        if (node.data.texto) blocos.push({ type: "text", text: interpolar(String(node.data.texto), state.dadosColetados) });
        return { messages: [new AIMessage({ content: blocos as never })] };
      };

    case "pergunta": {
      const p = perguntaDoNode(node);
      const semReescrita = node.data.semReescrita === true;
      return async (state: GraphState) => {
        const textoBase = interpolar(p.texto, state.dadosColetados);
        // conversacional: a IA reescreve a pergunta de forma acolhedora (preserva o pedido)
        const cfg = await obterConfig();
        const texto = cfg.conversacional && !semReescrita
          ? await reescreverPergunta(textoBase, p, state, cfg.estilo)
          : textoBase;
        return {
          messages: [mensagemPergunta({ ...p, texto, imagem: p.imagem ? interpolar(p.imagem, state.dadosColetados) : undefined })],
          perguntasFeitas: [p.chave],
          ultimaPergunta: p.chave,
        };
      };
    }

    case "ia":
      return async (state: GraphState) => {
        const fala = ultimaFalaUsuario(state);
        let contexto = "";
        if (node.data.usarRag && retriever) {
          const docs = await retriever.invoke(fala);
          contexto = `\n\n<contexto>\n${docs.map((d) => d.pageContent).join("\n\n")}\n</contexto>`;
        }
        // preâmbulo de estilo global (linguagem simples) + instrução do nó + RAG
        const estilo = await obterEstilo();
        const instrucao = node.data.prompt ? `${estilo}\n\n${node.data.prompt}` : estilo;
        const res = await model.invoke([
          new SystemMessage(instrucao + contexto),
          new HumanMessage(fala || "Olá"),
        ]);
        return { messages: [new AIMessage(res.content as string)] };
      };

    case "classificar": {
      // LLM escolhe 1 categoria da lista; grava em dadosColetados[chave].
      // Fallback por palavra-chave quando o modelo não está disponível.
      const opcoes = (node.data.opcoes ?? []).filter(Boolean);
      const chave = node.data.chave ?? "categoria";
      const porCategoria = ctx?.perguntasPorCategoria ?? {};
      const usarRag = node.data.usarRag !== false; // RAG ligado por padrão (mais acertivo)
      return async (state: GraphState) => {
        const fala = ultimaFalaUsuario(state);
        // contexto da base de conhecimento (serviços DPERJ) p/ classificar melhor
        let contextoRag: string | undefined;
        if (usarRag && retriever && fala.trim()) {
          try {
            const docs = await retriever.invoke(fala);
            contextoRag = docs.map((d) => d.pageContent).join("\n\n").slice(0, 4000);
          } catch (err) {
            console.warn("[classificar] RAG indisponível:", String(err).slice(0, 100));
          }
        }
        // 1º classifica; depois extrai SÓ as perguntas do tema escolhido (sem cross-fill)
        const categoria = await classificarTexto(fala, opcoes, node.data.prompt, contextoRag);
        const perguntasTema = porCategoria[categoria.toLowerCase()] ?? ctx?.perguntas ?? [];
        const extra = await extrairDoRelato(fala, perguntasTema, state.dadosColetados);
        return { dadosColetados: { [chave]: categoria, ...extra }, categoria };
      };
    }

    case "api":
      return async (state: GraphState) => {
        if (!node.data.url) return {};
        try {
          // url relativa ("/api/...") resolve contra SELF_URL → portável (não fixa localhost)
          const interpolada = interpolar(String(node.data.url), state.dadosColetados);
          const url = interpolada.startsWith("/") ? `${baseUrlInterna()}${interpolada}` : interpolada;
          const res = await fetch(url, {
            method: node.data.metodo ?? "POST",
            headers: { "Content-Type": "application/json" },
            body: node.data.metodo === "GET" ? undefined : JSON.stringify(state.dadosColetados),
            signal: AbortSignal.timeout(10_000),
          });
          const corpo = await res.text();
          return { dadosColetados: { [node.data.chave ?? "api_resultado"]: corpo.slice(0, 2000) } };
        } catch (err) {
          console.error(`[engine] node api ${node.id} falhou:`, err);
          return {};
        }
      };

    case "atribuir":
      return async (_state: GraphState) =>
        node.data.chave ? { dadosColetados: { [node.data.chave]: node.data.valor ?? "" } } : {};

    case "subgrafo": {
      // pergunta o próximo item pendente do serviço referenciado (loop é montado nas edges)
      const perguntas = servicoDe(node.data.servico ?? "outros").perguntas;
      return async (state: GraphState) => {
        const p = proxima(perguntas, state.dadosColetados);
        if (!p) return {};
        return { messages: [mensagemPergunta(p)], perguntasFeitas: [p.chave], ultimaPergunta: p.chave };
      };
    }

    case "encerrar":
      return enviarDados;

    case "condicao":
      return async (_state: GraphState) => ({}); // decisão acontece na conditional edge

    default:
      return async (_state: GraphState) => ({});
  }
}

// reconhece respostas afirmativas/negativas livres (além do canônico "true"/"false")
const AFIRMATIVO = /^(true|s|sim|aceit|ok|okay|concord|claro|quero|pode|positiv|confirm|y|yes)/i;
const NEGATIVO = /^(false|n|nao|não|recus|discord|nego|negativ)/i;

export function interpretarSimNao(fala: string): "sim" | "não" {
  const f = fala.trim();
  if (NEGATIVO.test(f)) return "não";
  if (AFIRMATIVO.test(f)) return "sim";
  return "não"; // ambíguo → não (seguro para aceites como LGPD)
}

// captura a resposta do usuário após o interrupt de um node pergunta
function criarCaptura(p: Pergunta) {
  return async (state: GraphState) => {
    const fala = ultimaFalaUsuario(state);
    if (!fala) return {};
    const valor = p.tipo === "sim_nao" ? interpretarSimNao(fala) : fala;
    return { dadosColetados: { [p.chave]: valor } };
  };
}

// ── Compilação ────────────────────────────────────────────────────────────────

// adjacência + alcançáveis a partir de um id
function alcancabilidade(edges: FlowEdge[]) {
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  return (id: string) => {
    const vis = new Set<string>();
    const pilha = [id];
    while (pilha.length) {
      const x = pilha.pop()!;
      if (vis.has(x)) continue;
      vis.add(x);
      for (const t of adj.get(x) ?? []) pilha.push(t);
    }
    return vis;
  };
}

// entrada: entre os nós sem edge de entrada, o que ALCANÇA mais nós
function entradaDe(nodes: FlowNode[], edges: FlowEdge[]): FlowNode {
  const alcancaveisDe = alcancabilidade(edges);
  const comEntrada = new Set(edges.map((e) => e.target));
  const candidatos = nodes.filter((n) => !comEntrada.has(n.id));
  let inicio = nodes[0];
  let melhor = -1;
  for (const c of candidatos.length ? candidatos : nodes) {
    const tam = alcancaveisDe(c.id).size;
    if (tam > melhor) { melhor = tam; inicio = c; }
  }
  return inicio;
}

// Substitui cada nó "subfluxo" pelos nós/edges do flow referenciado (ids prefixados).
// Entradas do nó → entrada do sub-flow; terminais do sub-flow → saídas do nó.
function expandirSubfluxos(nodes: FlowNode[], edges: FlowEdge[], subflows: SubflowMap): { nodes: FlowNode[]; edges: FlowEdge[] } {
  let N = [...nodes];
  let E = [...edges];
  for (const node of nodes) {
    if (node.type !== "subfluxo") continue;
    const sub = node.data.refFlowId ? subflows[node.data.refFlowId] : undefined;
    const entradasNode = edges.filter((e) => e.target === node.id);
    const saidasNode = edges.filter((e) => e.source === node.id);
    // remove o nó subfluxo e suas edges
    N = N.filter((n) => n.id !== node.id);
    E = E.filter((e) => e.source !== node.id && e.target !== node.id);

    if (!sub || !sub.nodes?.length) {
      // sem ref válida → vira pass-through: liga entradas direto às saídas
      for (const ent of entradasNode) for (const sai of saidasNode)
        E.push({ id: `pt_${ent.source}_${sai.target}`, source: ent.source, target: sai.target, label: ent.label });
      continue;
    }

    const pfx = `sf_${node.id}_`;
    const subNodes = sub.nodes.map((n) => ({ ...n, id: pfx + n.id }));
    const subEdges = sub.edges.map((e) => ({ ...e, id: pfx + e.id, source: pfx + e.source, target: pfx + e.target }));
    const entrada = pfx + entradaDe(sub.nodes, sub.edges).id;
    const comSaida = new Set(sub.edges.map((e) => e.source));
    const terminais = sub.nodes.filter((n) => !comSaida.has(n.id)); // nós-folha do sub-flow

    N = N.concat(subNodes);
    E = E.concat(subEdges);
    // entradas do nó subfluxo → entrada do sub-flow (preserva label da condição)
    for (const ent of entradasNode)
      E.push({ id: `in_${ent.source}_${entrada}`, source: ent.source, target: entrada, label: ent.label });

    // saídas: cada terminal do sub-flow liga às saídas do nó subfluxo.
    // Saída nomeada: terminal com data.saida casa com a seta de mesmo label.
    const semLabel = saidasNode.filter((s) => !s.label);
    for (const term of terminais) {
      const nome = (term.data.saida ?? "").toLowerCase().trim();
      const casados = nome ? saidasNode.filter((s) => (s.label ?? "").toLowerCase().trim() === nome) : [];
      const alvos = casados.length ? casados : (semLabel.length ? semLabel : saidasNode);
      for (const sai of alvos)
        E.push({ id: `out_${pfx}${term.id}_${sai.target}`, source: pfx + term.id, target: sai.target, label: sai.label });
    }
  }
  return { nodes: N, edges: E };
}

export function buildGraphFromFlow(flow: FlowJSON, subflows: SubflowMap = {}) {
  const expandido = expandirSubfluxos(flow.nodes ?? [], flow.edges ?? [], subflows);
  const nodes = expandido.nodes;
  const edges = expandido.edges;
  if (!nodes.length) throw new Error("flow sem nodes");

  const alcancaveisDe = alcancabilidade(edges);
  const inicio = entradaDe(nodes, edges);

  // poda nós inalcançáveis a partir da entrada (desconectados/desativados não
  // quebram o grafo — LangGraph rejeitaria UnreachableNode)
  const alcancaveis = alcancaveisDe(inicio.id);
  const nodesUsados = nodes.filter((n) => alcancaveis.has(n.id));
  const edgesUsados = edges.filter((e) => alcancaveis.has(e.source) && alcancaveis.has(e.target));

  const porId = new Map(nodesUsados.map((n) => [n.id, n]));
  const builder = new StateGraph(GraphAnnotation) as any;
  const interrupts: string[] = [];

  // todas as perguntas do fluxo → o classify usa p/ extração antecipada
  const todasPerguntas = nodesUsados.filter((n) => n.type === "pergunta").map(perguntaDoNode);

  // entrada efetiva de um nó: pergunta entra pelo gate (que pula se já respondida)
  const entrada = (id: string) => {
    const n = porId.get(id);
    return n && n.type === "pergunta" ? `gate_${id}` : id;
  };
  // origem efetiva: perguntas/subgrafos saem do node de captura
  const origem = (id: string) => {
    const n = porId.get(id);
    return n && (n.type === "pergunta" || n.type === "subgrafo") ? `cap_${id}` : id;
  };

  // perguntas alcançáveis a partir de um nó (p/ extração por tema)
  const perguntasAlcancaveis = (id: string) => {
    const r = alcancaveisDe(id);
    return nodesUsados.filter((n) => n.type === "pergunta" && r.has(n.id)).map(perguntaDoNode);
  };

  // nodes do flow (+ gate/captura/encerramento auxiliares)
  for (const node of nodesUsados) {
    // classify: mapeia categoria → perguntas do tema (extrai só do tema escolhido, sem cross-fill)
    let ctx: { perguntas: Pergunta[]; perguntasPorCategoria?: Record<string, Pergunta[]> } = { perguntas: todasPerguntas };
    if (node.type === "classificar") {
      const porCat: Record<string, Pergunta[]> = {};
      for (const e of edgesUsados.filter((e) => e.source === node.id)) {
        const lbl = (e.label ?? "").toLowerCase().trim();
        if (lbl) porCat[lbl] = perguntasAlcancaveis(e.target);
      }
      ctx = { perguntas: todasPerguntas, perguntasPorCategoria: porCat };
    }
    builder.addNode(node.id, criarNode(node, ctx));
    if (node.type === "pergunta") {
      builder.addNode(`gate_${node.id}`, async () => ({})); // no-op; decisão na conditional edge
      builder.addNode(`cap_${node.id}`, criarCaptura(perguntaDoNode(node)));
      interrupts.push(node.id);
    }
    if (node.type === "subgrafo") {
      builder.addNode(`cap_${node.id}`, extrator); // extrator completo (contexto + validações)
      interrupts.push(node.id);
    }
    if (node.type === "encerrar") {
      builder.addNode(`msg_${node.id}`, encerramento);
      builder.addEdge(node.id, `msg_${node.id}`);
      builder.addEdge(`msg_${node.id}`, END);
    }
  }

  builder.addEdge(START, entrada(inicio.id));

  for (const node of nodesUsados) {
    const saidas = edgesUsados.filter((e) => e.source === node.id);

    if (node.type === "pergunta") {
      const k = node.data.chave ?? node.id;
      const proximo = saidas[0]?.target;
      const destinoSkip = proximo ? entrada(proximo) : END;
      // gate: já respondida → pula direto pro próximo; senão → faz a pergunta
      builder.addConditionalEdges(
        `gate_${node.id}`,
        (state: GraphState) => {
          const v = resolverCampo(state.dadosColetados, k);
          return v != null && String(v).trim() !== "" ? "PULAR" : "PERGUNTAR";
        },
        { PULAR: destinoSkip, PERGUNTAR: node.id }
      );
      builder.addEdge(node.id, `cap_${node.id}`); // [INT] após perguntar
      if (!saidas.length) builder.addEdge(`cap_${node.id}`, END);
      else for (const e of saidas) builder.addEdge(`cap_${node.id}`, entrada(e.target));
      continue;
    }

    if (node.type === "subgrafo") {
      builder.addEdge(node.id, `cap_${node.id}`);
      const perguntas = servicoDe(node.data.servico ?? "outros").perguntas;
      const destino = saidas[0] ? entrada(saidas[0].target) : END;
      builder.addConditionalEdges(
        `cap_${node.id}`,
        (state: GraphState) => (proxima(perguntas, state.dadosColetados) ? node.id : destino),
        { [node.id]: node.id, [destino]: destino, [END]: END }
      );
      continue;
    }

    if (node.type === "condicao" || node.type === "classificar") {
      const campo = node.type === "condicao" ? (node.data.campo ?? "") : (node.data.chave ?? "categoria");
      const rota = (state: GraphState) => {
        const valor = node.type === "condicao"
          ? resolverCampoCondicao(state.dadosColetados, campo)
          : (resolverCampo(state.dadosColetados, campo) || "").toLowerCase().trim();
        const match = saidas.find((e) => (e.label ?? "").toLowerCase().trim() === valor);
        const fallback = saidas.find((e) => !e.label || e.label === "*");
        const alvo = (match ?? fallback ?? saidas[0])?.target;
        return alvo ? entrada(alvo) : END;
      };
      const destinos = Object.fromEntries(saidas.map((e) => [entrada(e.target), entrada(e.target)]));
      builder.addConditionalEdges(node.id, rota, { ...destinos, [END]: END });
      continue;
    }

    if (node.type === "encerrar") continue; // já ligado ao msg_/END

    if (!saidas.length) {
      builder.addEdge(origem(node.id), END);
    } else {
      for (const e of saidas) builder.addEdge(origem(node.id), entrada(e.target));
    }
  }

  return builder.compile({ checkpointer, interruptAfter: interrupts });
}

// ── Cache + seleção do grafo ativo ───────────────────────────────────────────

const cache = new Map<string, { versao: string; graph: ReturnType<typeof buildGraphFromFlow> }>();

type FlowRow = { id: string; updatedAt: Date; nodes: unknown; edges: unknown };

// ids de flows referenciados por nós "subfluxo"
export function subfluxosReferenciados(nodes: unknown): string[] {
  const arr = (nodes as FlowNode[]) ?? [];
  return [...new Set(arr.filter((n) => n.type === "subfluxo" && n.data?.refFlowId).map((n) => n.data.refFlowId!))];
}

export function graphDoFlow(flow: FlowRow, subflowRows: FlowRow[] = []) {
  // versão = updatedAt do principal + dos sub-flows (recompila se qualquer um muda)
  const versao = [flow, ...subflowRows].map((f) => `${f.id}:${f.updatedAt.toISOString()}`).sort().join("|");
  const hit = cache.get(flow.id);
  if (hit && hit.versao === versao) return hit.graph;

  const subflows: SubflowMap = {};
  for (const s of subflowRows) subflows[s.id] = { nodes: s.nodes as FlowNode[], edges: s.edges as FlowEdge[] };

  const compilado = buildGraphFromFlow(
    { id: flow.id, nodes: flow.nodes as FlowNode[], edges: flow.edges as FlowEdge[] },
    subflows
  );
  cache.set(flow.id, { versao, graph: compilado });
  return compilado;
}

export { graphEstatico };
