import type { FlowNode, FlowEdge } from "./builder.js";

// Validação estrutural de um fluxo (pura — sem compilar o grafo, sem DB).
// Pega erros que fariam o engine cair silenciosamente no grafo estático:
// arestas para nós inexistentes, nós sem campos obrigatórios, nós inalcançáveis.

export interface ResultadoValidacao {
  ok: boolean;
  erros: string[];   // bloqueiam/quebram o fluxo
  avisos: string[];  // suspeitos, não necessariamente fatais
}

// alcançáveis a partir de um nó (DFS no grafo dirigido)
function alcancaveisDe(edges: FlowEdge[], inicio: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  const vis = new Set<string>();
  const pilha = [inicio];
  while (pilha.length) {
    const x = pilha.pop()!;
    if (vis.has(x)) continue;
    vis.add(x);
    for (const t of adj.get(x) ?? []) pilha.push(t);
  }
  return vis;
}

// nó de entrada: o que não tem aresta de entrada e alcança mais nós (mesma
// heurística do builder.entradaDe)
function entradaDe(nodes: FlowNode[], edges: FlowEdge[]): FlowNode | null {
  if (!nodes.length) return null;
  const comEntrada = new Set(edges.map((e) => e.target));
  const candidatos = nodes.filter((n) => !comEntrada.has(n.id));
  let inicio = nodes[0];
  let melhor = -1;
  for (const c of candidatos.length ? candidatos : nodes) {
    const tam = alcancaveisDe(edges, c.id).size;
    if (tam > melhor) { melhor = tam; inicio = c; }
  }
  return inicio;
}

export function validarFlow(nodes: FlowNode[], edges: FlowEdge[]): ResultadoValidacao {
  const erros: string[] = [];
  const avisos: string[] = [];

  if (!nodes.length) {
    return { ok: false, erros: ["fluxo sem nós"], avisos };
  }

  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) erros.push("há nós com id duplicado");

  // arestas apontando para nós inexistentes
  for (const e of edges) {
    if (!ids.has(e.source)) erros.push(`aresta ${e.id ?? `${e.source}->${e.target}`}: source inexistente "${e.source}"`);
    if (!ids.has(e.target)) erros.push(`aresta ${e.id ?? `${e.source}->${e.target}`}: target inexistente "${e.target}"`);
  }

  // campos obrigatórios por tipo de nó
  for (const n of nodes) {
    const d = n.data ?? {};
    switch (n.type) {
      case "condicao":
        if (!d.campo) erros.push(`condicao "${n.id}" sem data.campo`);
        break;
      case "pergunta": {
        if (!d.chave) erros.push(`pergunta "${n.id}" sem data.chave`);
        if (!d.texto) avisos.push(`pergunta "${n.id}" sem texto`);
        // múltiplas saídas: só roteiam em sim_nao com labels true/false —
        // sem isso o engine executa TODOS os ramos (fan-out silencioso, #45)
        const saidas = edges.filter((e) => e.source === n.id);
        if (saidas.length > 1) {
          if (d.tipoPergunta !== "sim_nao") {
            erros.push(
              `pergunta "${n.id}" tem ${saidas.length} saídas mas não é sim_nao — todos os ramos executariam juntos; use um nó condição para rotear`
            );
          } else {
            const labels = saidas.map((e) => (e.label ?? "").toLowerCase().trim());
            const validos = new Set(["true", "false", "*", ""]);
            const invalidos = labels.filter((l) => !validos.has(l));
            if (invalidos.length)
              erros.push(
                `pergunta "${n.id}": labels ${invalidos.map((l) => `"${l}"`).join(", ")} não roteiam — use "true"/"false" (ids dos botões)`
              );
            if (!labels.some((l) => l === "true" || l === "false"))
              erros.push(
                `pergunta "${n.id}" tem ${saidas.length} saídas sem labels true/false — todos os ramos executariam juntos`
              );
          }
        }
        break;
      }
      case "api": {
        if (!d.url) erros.push(`api "${n.id}" sem data.url`);
        if (!d.chave) avisos.push(`api "${n.id}" sem data.chave (resultado não é gravado)`);
        const urlApi = String(d.url ?? "");
        const externa = /^https?:\/\//i.test(urlApi);
        // LGPD: pra fora, PII só com seleção explícita — sem camposCorpo o corpo vai VAZIO
        if (externa && !Array.isArray(d.camposCorpo))
          avisos.push(
            `api "${n.id}": URL externa sem data.camposCorpo — o corpo será enviado VAZIO; selecione as chaves a enviar`
          );
        // header com cara de credencial crua persistiria o segredo no banco
        for (const [nome, valor] of Object.entries((d.headers ?? {}) as Record<string, string>))
          if (/(key|token|auth|secret)/i.test(nome) && !/\{\{secret:\w+\}\}/.test(String(valor)))
            avisos.push(
              `api "${n.id}": header "${nome}" parece credencial em texto puro — use {{secret:NOME}} (resolvido do ambiente)`
            );
        // múltiplas saídas só roteiam com uma edge rotulada "erro"
        const saidasApi = edges.filter((e) => e.source === n.id);
        if (saidasApi.length > 1) {
          const labels = saidasApi.map((e) => (e.label ?? "").toLowerCase().trim());
          if (!labels.includes("erro"))
            erros.push(
              `api "${n.id}" tem ${saidasApi.length} saídas sem label "erro" — todos os ramos executariam juntos; rotule a saída de falha com "erro"`
            );
          const invalidos = labels.filter((l) => !["erro", "*", ""].includes(l));
          if (invalidos.length)
            erros.push(
              `api "${n.id}": labels ${invalidos.map((l) => `"${l}"`).join(", ")} não roteiam — só "erro" (falha) e sem label/"*" (sucesso)`
            );
        }
        break;
      }
      case "subfluxo":
        if (!d.refFlowId) erros.push(`subfluxo "${n.id}" sem data.refFlowId`);
        break;
      case "atribuir":
        if (!d.chave) erros.push(`atribuir "${n.id}" sem data.chave`);
        break;
      case "classificar":
        if (!d.chave) erros.push(`classificar "${n.id}" sem data.chave`);
        break;
      case "mensagem":
        if (!d.texto && !d.imagem) avisos.push(`mensagem "${n.id}" sem texto e sem imagem`);
        break;
    }
  }

  // alcançabilidade a partir da entrada
  const entrada = entradaDe(nodes, edges);
  if (!entrada) {
    erros.push("não foi possível determinar o nó de entrada");
  } else {
    const alcancaveis = alcancaveisDe(edges, entrada.id);
    for (const n of nodes) {
      if (!alcancaveis.has(n.id)) avisos.push(`nó inalcançável a partir da entrada: "${n.id}"`);
    }
  }

  return { ok: erros.length === 0, erros, avisos };
}
