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
  type: "mensagem" | "pergunta" | "condicao" | "ia" | "api" | "subgrafo" | "atribuir" | "encerrar";
  position?: { x: number; y: number }; // usado só pelo frontend
  data: {
    label?: string;
    texto?: string;            // mensagem | pergunta
    imagem?: string;           // mensagem (url)
    chave?: string;            // pergunta | api | atribuir
    tipoPergunta?: TipoPergunta;
    opcoes?: string[];
    campo?: string;            // condicao: campo de dadosColetados a comparar
    prompt?: string;           // ia: system prompt
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

// ── Funções de nó ─────────────────────────────────────────────────────────────

function criarNode(node: FlowNode) {
  switch (node.type) {
    case "mensagem":
      return async (_state: GraphState) => {
        const blocos: object[] = [];
        if (node.data.imagem) blocos.push({ type: "image_url", image_url: { url: node.data.imagem } });
        if (node.data.texto) blocos.push({ type: "text", text: node.data.texto });
        return { messages: [new AIMessage({ content: blocos as never })] };
      };

    case "pergunta": {
      const p = perguntaDoNode(node);
      return async (_state: GraphState) => ({
        messages: [mensagemPergunta(p)],
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
        const valor = (state.dadosColetados[campo] ?? "").toLowerCase().trim();
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
