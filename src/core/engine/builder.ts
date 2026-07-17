import { StateGraph, END, START } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { obterEstilo, obterConfig, styleVersion } from "../config.js";
import { env } from "../env.js";
import { resolverCampo, resolverCampoCondicao, interpolar } from "./campos.js";
import {
  model, retriever, ultimaFalaUsuario,
  classificarTexto, extrairDoRelato, reescreverPergunta,
} from "./ia.js";
import { avaliarTom } from "./sentimento.js";
import { registrarVisitaNode } from "../analytics.js";
import { formatoValido, mensagemErroFormato, temValidadorDeFormato } from "./validacao-resposta.js";
import { GraphAnnotation, type GraphState } from "../state.js";
import { checkpointer, graph as graphEstatico } from "../graph.js";
import { mensagemPergunta, proxima, type Pergunta, type TipoPergunta } from "../perguntas.js";
import { extrator } from "../nodes/atendimento/extrator.js";
import { enviarDados } from "../nodes/atendimento/enviar-dados.js";
import { encerramento } from "../nodes/atendimento/encerramento.js";
import { servicoDe } from "../registro-perguntas.js";

// categorias que sempre pedem o tom mais acolhedor (público fragilizado)
const TEMAS_SENSIVEIS = ["violencia", "violência", "penal", "saude", "saúde", "menor", "crianca", "criança", "obito", "óbito"];

// Compila um Flow (JSON criado no builder visual do painel admin) em um grafo
// LangGraph executável. Tipos de nó (espelho da paleta do React Flow):
//   mensagem | pergunta | condicao | ia | api | subgrafo | atribuir | encerrar

export interface FlowNode {
  id: string;
  type: "mensagem" | "pergunta" | "condicao" | "ia" | "classificar" | "api" | "subgrafo" | "subfluxo" | "atribuir" | "encerrar" | "transferir_humano";
  position?: { x: number; y: number }; // layout do builder visual (ignorado pelo engine)
  data: {
    label?: string;
    titulo?: string;           // identificação no canvas (api | condicao | classificar | subfluxo)
    texto?: string;            // mensagem | pergunta | encerrar | transferir_humano (texto opcional antes de pausar)
    imagem?: string;           // mensagem (url)
    textoAntes?: boolean;      // mensagem: emite texto antes da imagem (padrão: imagem primeiro)
    chave?: string;            // pergunta | api | atribuir | classificar (campo onde grava a categoria)
    tipoPergunta?: TipoPergunta;
    opcoes?: string[];         // pergunta(opcoes) | classificar (categorias possíveis)
    campo?: string;            // condicao: campo de dadosColetados a comparar
    prompt?: string;           // ia | classificar: instrução extra ao LLM
    usarRag?: boolean;         // ia
    url?: string;              // api (relativa = interna; absoluta = externa)
    metodo?: "GET" | "POST";   // api
    headers?: Record<string, string>; // api: headers extras; valor aceita {{chave}} e {{secret:NOME}} (env)
    camposCorpo?: string[];    // api: chaves de dadosColetados enviadas no corpo (externa sem isso = corpo vazio)
    limiteResposta?: number;   // api: limite de chars da resposta gravada (default 2000)
    servico?: string;          // subgrafo: categoria (familia_pensao | trabalhista | ...)
    refFlowId?: string;        // subfluxo: id do Flow embutido (tema editável no painel)
    saida?: string;            // sub-flow: nomeia a saída deste nó-folha (casa com label da seta do subfluxo)
    semReescrita?: boolean;    // pergunta: não reescrever com IA (texto fixo — ex: LGPD/links)
    valor?: string;            // atribuir
    ctaUrl?: string;           // mensagem: botão que abre link (interpolável, ex: {{kyc.url}})
    ctaTexto?: string;         // mensagem: rótulo do botão cta_url (<=20 chars)
    nota?: string;             // qualquer tipo: anotação livre do editor — engine ignora em runtime
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


// base do próprio servidor para chamadas internas do fluxo (nós api com url relativa)
function baseUrlInterna(): string {
  return env.selfUrl();
}

// {{secret:NOME}} em headers do nó api resolve de env/Secrets Manager em
// runtime — o valor NUNCA vive no JSON do fluxo (banco) nem aparece em log
function resolverSecrets(valor: string, nodeId: string): string {
  return valor.replace(/\{\{secret:(\w+)\}\}/g, (_, nome) => {
    const v = process.env[nome];
    if (v === undefined) console.warn(`[engine] node api ${nodeId}: secret "${nome}" não definida no ambiente`);
    return v ?? "";
  });
}

// ── Funções de nó ─────────────────────────────────────────────────────────────

// ctx.perguntas = todas as perguntas; ctx.perguntasPorCategoria = perguntas por tema (classify)
function criarNode(node: FlowNode, ctx?: { perguntas: Pergunta[]; perguntasPorCategoria?: Record<string, Pergunta[]> }) {
  switch (node.type) {
    case "mensagem":
      return async (state: GraphState) => {
        const img = node.data.imagem
          ? { type: "image_url", image_url: { url: interpolar(String(node.data.imagem), state.dadosColetados) } }
          : null;
        const txt = node.data.texto
          ? { type: "text", text: interpolar(String(node.data.texto), state.dadosColetados) }
          : null;
        // botão que abre link (ex: KYC). ctaUrl interpolado; rótulo em ctaTexto.
        const cta = node.data.ctaUrl
          ? { type: "cta_url", url: interpolar(String(node.data.ctaUrl), state.dadosColetados), text: node.data.ctaTexto ? String(node.data.ctaTexto) : "Abrir" }
          : null;
        // padrão: imagem antes do texto. textoAntes=true inverte (texto → imagem)
        const blocos = [...(node.data.textoAntes ? [txt, img] : [img, txt]), cta].filter(Boolean);
        return { messages: [new AIMessage({ content: blocos as never })] };
      };

    case "pergunta": {
      const p = perguntaDoNode(node);
      const semReescrita = node.data.semReescrita === true;
      return async (state: GraphState) => {
        // conversacional: reescrita acolhedora (cacheada por pergunta+tom+estilo)
        const cfg = await obterConfig();
        const texto = cfg.conversacional && !semReescrita
          ? await reescreverPergunta(p, state, cfg.estilo, {
              tom: state.dadosColetados.tom,
              styleVersion: await styleVersion(),
            })
          : interpolar(p.texto, state.dadosColetados);
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
        // regra de segurança: tema sensível força o tom mais acolhedor (público vulnerável)
        if (TEMAS_SENSIVEIS.some((t) => categoria.toLowerCase().includes(t))) extra.tom = "acolhedor-forte";
        return { dadosColetados: { [chave]: categoria, ...extra }, categoria };
      };
    }

    case "api": {
      const chave = node.data.chave ?? "api_resultado";
      // url relativa ("/api/...") = endpoint interno; absoluta = API externa
      const interna = String(node.data.url ?? "").startsWith("/");
      return async (state: GraphState, config?: { configurable?: { thread_id?: string } }) => {
        if (!node.data.url) return {};
        try {
          // url relativa resolve contra SELF_URL → portável (não fixa localhost)
          const interpolada = interpolar(String(node.data.url), state.dadosColetados);
          const url = interna ? `${baseUrlInterna()}${interpolada}` : interpolada;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          for (const [nome, valor] of Object.entries((node.data.headers ?? {}) as Record<string, string>))
            headers[nome] = resolverSecrets(interpolar(String(valor), state.dadosColetados), node.id);
          // corpo: seleção explícita de chaves quando configurada; sem seleção,
          // interna mantém o payload completo e externa manda VAZIO (LGPD —
          // PII de terceiros só com escolha consciente do gestor)
          const campos = Array.isArray(node.data.camposCorpo) ? (node.data.camposCorpo as string[]) : null;
          const corpoEnvio: Record<string, unknown> = campos
            ? Object.fromEntries(campos.map((c) => [c, state.dadosColetados[c]]))
            : interna
              ? { ...state.dadosColetados }
              : {};
          // sessão/canal permitem retomada assíncrona (ex: KYC) — só pra dentro,
          // identificador de sessão não vaza pra terceiros
          if (interna) Object.assign(corpoEnvio, { _sessao: config?.configurable?.thread_id, _canal: state.canal });
          const res = await fetch(url, {
            method: node.data.metodo ?? "POST",
            headers,
            body: node.data.metodo === "GET" ? undefined : JSON.stringify(corpoEnvio),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const limite = Number(node.data.limiteResposta) > 0 ? Number(node.data.limiteResposta) : 2000;
          const corpo = await res.text();
          if (corpo.length > limite)
            console.warn(`[engine] node api ${node.id}: resposta truncada (${corpo.length} > ${limite} chars)`);
          return { dadosColetados: { [chave]: corpo.slice(0, limite), [`${chave}_erro`]: "false" } };
        } catch (err) {
          console.error(`[engine] node api ${node.id} falhou:`, err);
          // marca a falha p/ rotear pela edge "erro" (quando existir) ou por condição
          return { dadosColetados: { [`${chave}_erro`]: "true" } };
        }
      };
    }

    case "atribuir":
      return async (state: GraphState) =>
        node.data.chave
          ? { dadosColetados: { [node.data.chave]: interpolar(String(node.data.valor ?? ""), state.dadosColetados) } }
          : {};

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

    // pausa o atendimento automático e sinaliza handoff pro rastrearConversa()
    // gravar Conversation.handoffStatus="aguardando" (ver core/chat.ts). O nó
    // entra em `interrupts` (como pergunta) — graph.invoke() para aqui.
    case "transferir_humano":
      return async (state: GraphState) => {
        const texto = node.data.texto
          ? interpolar(String(node.data.texto), state.dadosColetados)
          : "Vou te conectar com um atendente humano. Só um momento, já já alguém te responde por aqui mesmo. 🙏";
        return { messages: [new AIMessage(texto)], handoff: "aguardando" };
      };

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

// tentativas inválidas seguidas antes de desistir de re-perguntar e aceitar o
// valor bruto (nunca travar o assistido num loop infinito — card #20260120)
const LIMITE_TENTATIVAS = 3;

// captura a resposta do usuário após o interrupt de um node pergunta.
// avaliarSentimento: só true p/ perguntas livres de tema (sf_* + tipo texto) —
// V2 do tom via Comprehend, reavalia por turno com histerese (só escalona).
function criarCaptura(p: Pergunta, avaliarSentimento = false) {
  return async (state: GraphState) => {
    const fala = ultimaFalaUsuario(state);
    if (!fala) return {};
    const valor = p.tipo === "sim_nao" ? interpretarSimNao(fala) : fala;

    if (!formatoValido(p.tipo, valor)) {
      const novoCount = (state.tentativas[p.chave] ?? 0) + 1;
      if (novoCount <= LIMITE_TENTATIVAS) {
        return {
          messages: [new AIMessage(mensagemErroFormato(p.tipo))],
          tentativas: { [p.chave]: novoCount },
        };
      }
      // limite estourado: segue com o valor bruto mesmo fora do formato
    }

    const dados: Record<string, unknown> = { [p.chave]: valor };
    if (avaliarSentimento) {
      const tom = await avaliarTom(fala, state.dadosColetados.tom as string | undefined);
      if (tom) dados.tom = tom;
    }
    return { dadosColetados: dados };
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
// Roda em passadas até não sobrar nó "subfluxo" — suporta aninhamento (subfluxo
// dentro de subfluxo, ex: um "Orquestrador" reutilizável que embute outros
// temas). Limite de profundidade evita loop em referência circular (A embute
// B que embute A). O caller (chat.ts/admin.ts) precisa ter carregado TODOS os
// sub-flows aninhados em `subflows` — ver carregarSubflowsRecursivo.
function expandirSubfluxos(nodes: FlowNode[], edges: FlowEdge[], subflows: SubflowMap): { nodes: FlowNode[]; edges: FlowEdge[] } {
  let N = [...nodes];
  let E = [...edges];

  for (let profundidade = 0; profundidade < 10; profundidade++) {
    const pendentes = N.filter((n) => n.type === "subfluxo");
    if (!pendentes.length) break;

    for (const node of pendentes) {
      const sub = node.data.refFlowId ? subflows[node.data.refFlowId] : undefined;
      const entradasNode = E.filter((e) => e.target === node.id);
      const saidasNode = E.filter((e) => e.source === node.id);
      // remove o nó subfluxo e suas edges
      N = N.filter((n) => n.id !== node.id);
      E = E.filter((e) => e.source !== node.id && e.target !== node.id);

      if (!sub?.nodes?.length) {
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
  }
  return { nodes: N, edges: E };
}

// Nós do flow (principal + sub-flows) APÓS expandirSubfluxos — mesmos ids
// prefixados (sf_<nodeSubfluxo>_<idOriginal>) que o grafo compilado usa em
// ultimaPergunta/dadosColetados. Usado por chat.ts (tipoPerguntaPendente)
// pra resolver o tipoPergunta de uma chave sem reprocessar mensagem — usar a
// lista CRUA de flow.nodes ali causava mismatch pra pergunta de subfluxo sem
// data.chave explícita (id vira prefixado só depois da expansão).
export function nosExpandidos(flow: FlowRow, subflowRows: FlowRow[] = []): FlowNode[] {
  const subflows: SubflowMap = {};
  for (const s of subflowRows) subflows[s.id] = { nodes: s.nodes as FlowNode[], edges: s.edges as FlowEdge[] };
  const nodes = (flow.nodes as FlowNode[]) ?? [];
  const edges = (flow.edges as FlowEdge[]) ?? [];
  return expandirSubfluxos(nodes, edges, subflows).nodes;
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
    const fnNode = criarNode(node, ctx);
    builder.addNode(node.id, async (state: GraphState) => {
      registrarVisitaNode(flow.id, node.id);
      const resultado = await fnNode(state);
      // trilha de execução (issue #93): ponto central único — cobre todos os
      // tipos de node, incluindo ids prefixados de subfluxo expandido, sem
      // precisar duplicar em cada case de criarNode()
      return { ...resultado, trilhaExecutada: [node.id] };
    });
    if (node.type === "pergunta") {
      builder.addNode(`gate_${node.id}`, async () => ({})); // no-op; decisão na conditional edge
      // pergunta livre de tema (dentro de subfluxo expandido, texto aberto) → V2 do tom
      const livreDeTema = node.id.startsWith("sf_") && (node.data.tipoPergunta ?? "texto") === "texto";
      builder.addNode(`cap_${node.id}`, criarCaptura(perguntaDoNode(node), livreDeTema));
      interrupts.push(node.id);
    }
    if (node.type === "subgrafo") {
      builder.addNode(`cap_${node.id}`, extrator); // extrator completo (contexto + validações)
      interrupts.push(node.id);
    }
    // pausa aqui — sem nó de captura (não processa a próxima mensagem
    // automaticamente; processarMensagem() filtra enquanto handoffStatus
    // estiver ativo). Sem edge de saída configurada → segue pro END quando
    // liberado; com edge → continua o fluxo normalmente.
    if (node.type === "transferir_humano") {
      interrupts.push(node.id);
    }
    if (node.type === "encerrar") {
      // despedida customizada pelo gestor (data.texto) substitui a mensagem padrão;
      // {{protocolo}} entra como variável (msg_ roda depois do enviarDados)
      const despedida = node.data.texto ? String(node.data.texto) : null;
      builder.addNode(
        `msg_${node.id}`,
        despedida
          ? async (state: GraphState) => ({
              messages: [new AIMessage(interpolar(despedida, { ...state.dadosColetados, protocolo: state.protocolo ?? "" }))],
            })
          : encerramento
      );
      builder.addEdge(node.id, `msg_${node.id}`);
      builder.addEdge(`msg_${node.id}`, END);
    }
  }

  builder.addEdge(START, entrada(inicio.id));

  for (const node of nodesUsados) {
    const saidas = edgesUsados.filter((e) => e.source === node.id);

    if (node.type === "pergunta") {
      const k = node.data.chave ?? node.id;
      // pergunta sim_nao com saídas rotuladas true/false roteia DIRETO pela
      // resposta — dispensa o nó condição no caso comum (Coilab #20260113).
      const roteiaPorLabel =
        node.data.tipoPergunta === "sim_nao" && saidas.some((e) => e.label);
      const rotaPorResposta = (state: GraphState) => {
        const valor = resolverCampoCondicao(state.dadosColetados, k);
        const match = saidas.find((e) => (e.label ?? "").toLowerCase().trim() === valor);
        const fallback = saidas.find((e) => !e.label || e.label === "*");
        const alvo = (match ?? fallback ?? saidas[0])?.target;
        return alvo ? entrada(alvo) : END;
      };
      const destinosRotulados = Object.fromEntries(
        saidas.map((e) => [entrada(e.target), entrada(e.target)])
      );

      const proximo = saidas[0]?.target;
      const destinoSkip = proximo ? entrada(proximo) : END;
      // gate: já respondida → pula (roteando pela resposta preenchida quando
      // as saídas são rotuladas); senão → faz a pergunta
      builder.addConditionalEdges(
        `gate_${node.id}`,
        (state: GraphState) => {
          const v = resolverCampo(state.dadosColetados, k);
          if (v == null || String(v).trim() === "") return "PERGUNTAR";
          return roteiaPorLabel ? rotaPorResposta(state) : "PULAR";
        },
        { PULAR: destinoSkip, PERGUNTAR: node.id, ...destinosRotulados, [END]: END }
      );
      builder.addEdge(node.id, `cap_${node.id}`); // [INT] após perguntar
      // tipos com validador de formato (derivado de VALIDADORES em
      // validacao-resposta.ts — nunca listar aqui à mão, senão um tipo novo
      // com validador fica sem esse fio e a captura inválida avança em
      // silêncio), saída única: captura inválida (dadosColetados[k] não
      // gravado, ver criarCaptura) volta pro próprio node.id — re-pergunta
      // com mensagem de erro. "documento" segue o mesmo LIMITE_TENTATIVAS dos
      // demais: após 3 falhas o valor bruto (texto não-JSON) fica em
      // dadosColetados[k] — edge case raro aceito.
      const tipoComValidador = temValidadorDeFormato(node.data.tipoPergunta ?? "texto");
      if (!saidas.length) builder.addEdge(`cap_${node.id}`, END);
      else if (roteiaPorLabel)
        builder.addConditionalEdges(`cap_${node.id}`, rotaPorResposta, {
          ...destinosRotulados,
          [END]: END,
        });
      else if (tipoComValidador && saidas.length === 1) {
        const destino = entrada(saidas[0].target);
        builder.addConditionalEdges(
          `cap_${node.id}`,
          (state: GraphState) => {
            const v = resolverCampo(state.dadosColetados, k);
            return v == null || String(v).trim() === "" ? node.id : destino;
          },
          { [destino]: destino, [node.id]: node.id }
        );
      } else for (const e of saidas) builder.addEdge(`cap_${node.id}`, entrada(e.target));
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

    // api com saída rotulada "erro" roteia falha/timeout/status não-ok pra lá;
    // as demais saídas (sem label ou "*") são o caminho feliz
    if (node.type === "api" && saidas.some((e) => (e.label ?? "").toLowerCase().trim() === "erro")) {
      const chave = node.data.chave ?? "api_resultado";
      const edgeErro = saidas.find((e) => (e.label ?? "").toLowerCase().trim() === "erro")!;
      const edgeOk = saidas.find((e) => e !== edgeErro);
      const rota = (state: GraphState) => {
        const falhou = resolverCampo(state.dadosColetados, `${chave}_erro`) === "true";
        const alvo = (falhou ? edgeErro : edgeOk)?.target;
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

export type FlowRow = { id: string; updatedAt: Date; nodes: unknown; edges: unknown };

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
