import { StateGraph, END, START } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { ChatBedrockConverse } from "@langchain/aws";
import { AmazonKnowledgeBaseRetriever } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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
  type: "mensagem" | "pergunta" | "condicao" | "ia" | "classificar" | "api" | "subgrafo" | "atribuir" | "encerrar";
  position?: { x: number; y: number }; // usado só pelo frontend
  data: {
    label?: string;
    titulo?: string;           // identificação no canvas (api | condicao | classificar)
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
    valor?: string;            // atribuir
  };
}

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
async function classificarTexto(fala: string, opcoes: string[], prompt?: string): Promise<string> {
  if (!opcoes.length) return "";
  if (!fala.trim()) return opcoes[opcoes.length - 1]; // sem relato → última (geralmente "outros")

  try {
    const instrucao =
      (prompt ?? "Você classifica o relato de um cidadão em uma categoria de serviço jurídico.") +
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
  return opcoes[opcoes.length - 1]; // default → última categoria (ex: "outros")
}

// interpola {{chave}} / {{chave.sub}} com dadosColetados — ex: "CPF: {{cpf}}"
function interpolar(txt: string, dados: Record<string, unknown>): string {
  return txt.replace(/\{\{([\w.]+)\}\}/g, (_, k) => resolverCampo(dados, k));
}

// ── Funções de nó ─────────────────────────────────────────────────────────────

function criarNode(node: FlowNode) {
  switch (node.type) {
    case "mensagem":
      return async (state: GraphState) => {
        const blocos: object[] = [];
        if (node.data.imagem) blocos.push({ type: "image_url", image_url: { url: node.data.imagem } });
        if (node.data.texto) blocos.push({ type: "text", text: interpolar(String(node.data.texto), state.dadosColetados) });
        return { messages: [new AIMessage({ content: blocos as never })] };
      };

    case "pergunta": {
      const p = perguntaDoNode(node);
      return async (state: GraphState) => ({
        messages: [mensagemPergunta({ ...p, texto: interpolar(p.texto, state.dadosColetados) })],
        perguntasFeitas: [p.chave],
        ultimaPergunta: p.chave,
      });
    }

    case "ia":
      return async (state: GraphState) => {
        const fala = ultimaFalaUsuario(state);
        let contexto = "";
        if (node.data.usarRag && retriever) {
          const docs = await retriever.invoke(fala);
          contexto = `\n\n<contexto>\n${docs.map((d) => d.pageContent).join("\n\n")}\n</contexto>`;
        }
        const res = await model.invoke([
          new SystemMessage((node.data.prompt ?? "Você é a Maria, assistente da Defensoria Pública do RJ.") + contexto),
          new HumanMessage(fala || "Olá"),
        ]);
        return { messages: [new AIMessage(res.content as string)] };
      };

    case "classificar": {
      // LLM escolhe 1 categoria da lista; grava em dadosColetados[chave].
      // Fallback por palavra-chave quando o modelo não está disponível.
      const opcoes = (node.data.opcoes ?? []).filter(Boolean);
      const chave = node.data.chave ?? "categoria";
      return async (state: GraphState) => {
        const fala = ultimaFalaUsuario(state);
        const categoria = await classificarTexto(fala, opcoes, node.data.prompt);
        return { dadosColetados: { [chave]: categoria }, categoria };
      };
    }

    case "api":
      return async (state: GraphState) => {
        if (!node.data.url) return {};
        try {
          const res = await fetch(node.data.url, {
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

// captura a resposta do usuário após o interrupt de um node pergunta
function criarCaptura(p: Pergunta) {
  return async (state: GraphState) => {
    const fala = ultimaFalaUsuario(state);
    if (!fala) return {};
    let valor = fala;
    if (p.tipo === "sim_nao") valor = fala === "true" || /^s/i.test(fala) ? "sim" : "não";
    return { dadosColetados: { [p.chave]: valor } };
  };
}

// ── Compilação ────────────────────────────────────────────────────────────────

export function buildGraphFromFlow(flow: FlowJSON) {
  const nodes = flow.nodes ?? [];
  const edges = flow.edges ?? [];
  if (!nodes.length) throw new Error("flow sem nodes");

  const porId = new Map(nodes.map((n) => [n.id, n]));
  const builder = new StateGraph(GraphAnnotation) as any;
  const interrupts: string[] = [];

  // nodes do flow (+ captura/encerramento auxiliares)
  for (const node of nodes) {
    builder.addNode(node.id, criarNode(node));
    if (node.type === "pergunta") {
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

  // entrada: primeiro node sem edge de entrada (fallback: primeiro da lista)
  const comEntrada = new Set(edges.map((e) => e.target));
  const inicio = nodes.find((n) => !comEntrada.has(n.id)) ?? nodes[0];
  builder.addEdge(START, inicio.id);

  // origem efetiva de uma edge: perguntas/subgrafos saem do node de captura
  const origem = (id: string) => {
    const n = porId.get(id);
    return n && (n.type === "pergunta" || n.type === "subgrafo") ? `cap_${id}` : id;
  };

  for (const node of nodes) {
    const saidas = edges.filter((e) => e.source === node.id);

    if (node.type === "pergunta") builder.addEdge(node.id, `cap_${node.id}`);

    if (node.type === "subgrafo") {
      // loop: pergunta → [INT] → extrator → (pendente? volta : segue)
      builder.addEdge(node.id, `cap_${node.id}`);
      const perguntas = servicoDe(node.data.servico ?? "outros").perguntas;
      const destino = saidas[0]?.target;
      builder.addConditionalEdges(
        `cap_${node.id}`,
        (state: GraphState) => (proxima(perguntas, state.dadosColetados) ? node.id : destino ?? END),
        destino ? { [node.id]: node.id, [destino]: destino } : { [node.id]: node.id, [END]: END }
      );
      continue;
    }

    if (node.type === "condicao") {
      const campo = node.data.campo ?? "";
      const rota = (state: GraphState) => {
        const valor = resolverCampoCondicao(state.dadosColetados, campo);
        const match = saidas.find((e) => (e.label ?? "").toLowerCase().trim() === valor);
        const fallback = saidas.find((e) => !e.label || e.label === "*");
        return (match ?? fallback ?? saidas[0])?.target ?? END;
      };
      const destinos = Object.fromEntries(saidas.map((e) => [e.target, e.target]));
      builder.addConditionalEdges(node.id, rota, { ...destinos, [END]: END });
      continue;
    }

    if (node.type === "classificar") {
      // o node já gravou dadosColetados[chave]=categoria; roteia direto pelas setas
      const chave = node.data.chave ?? "categoria";
      const rota = (state: GraphState) => {
        const valor = (resolverCampo(state.dadosColetados, chave) || "").toLowerCase().trim();
        const match = saidas.find((e) => (e.label ?? "").toLowerCase().trim() === valor);
        const fallback = saidas.find((e) => !e.label || e.label === "*");
        return (match ?? fallback ?? saidas[0])?.target ?? END;
      };
      const destinos = Object.fromEntries(saidas.map((e) => [e.target, e.target]));
      builder.addConditionalEdges(node.id, rota, { ...destinos, [END]: END });
      continue;
    }

    if (node.type === "encerrar") continue; // já ligado ao msg_/END

    if (!saidas.length) {
      builder.addEdge(origem(node.id), END);
    } else {
      for (const e of saidas) builder.addEdge(origem(node.id), e.target);
    }
  }

  return builder.compile({ checkpointer, interruptAfter: interrupts });
}

// ── Cache + seleção do grafo ativo ───────────────────────────────────────────

const cache = new Map<string, { versao: string; graph: ReturnType<typeof buildGraphFromFlow> }>();

export function graphDoFlow(flow: { id: string; updatedAt: Date; nodes: unknown; edges: unknown }) {
  const versao = flow.updatedAt.toISOString();
  const hit = cache.get(flow.id);
  if (hit && hit.versao === versao) return hit.graph;
  const compilado = buildGraphFromFlow({
    id: flow.id,
    nodes: flow.nodes as FlowNode[],
    edges: flow.edges as FlowEdge[],
  });
  cache.set(flow.id, { versao, graph: compilado });
  return compilado;
}

export { graphEstatico };
