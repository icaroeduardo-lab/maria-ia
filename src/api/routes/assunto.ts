import type { FastifyInstance } from "fastify";
import { gatewayVerdeGet } from "../../core/gateway-verde.js";

// Rotas de identificação de assunto (card Coilab #20260185) — navega a
// árvore de assuntos real do Verde (assunto/categorias → consultar-item-
// arvore, recursivo) até achar um idAssunto concreto. A árvore tem vários
// níveis de pergunta (não é categoria→id direto, confirmado testando ao
// vivo: Divórcio/Pensão levam 3+ níveis) — por isso o subfluxo "Identificar
// Assunto" no builder visual chama esta rota em loop, uma pergunta por vez.
//
// Também expõe metadados do assunto já identificado (card #20260153, issue
// #132) — urgência e documentos necessários, uma vez que idAssunto é conhecido.
//
// E, pra mensagem de sucesso do agendamento em "Primeiro Atendimento (Órgão)"
// (`cms3obaj90001mk0jl806kbr5`), uma lista formatada dos documentos exigidos
// a partir do array estruturado `documentosNecessarios` (POST /documentos,
// abaixo) — o campo que o comentário de /metadados dizia "adicionar quando
// um fluxo precisar renderizar item a item": chegou a hora.

interface RespostaArvore {
  id?: number;
  resposta?: string;
}
interface ItemArvoreVerdeRaw {
  dados?: {
    pergunta?: string;
    nomeAssunto?: string;
    idAssunto?: number;
    assuntoEncontrado?: boolean;
    respostas?: RespostaArvore[];
  };
}

// Shape real de GET api/assunto/{idAssunto} do gateway (card Coilab #20260153,
// issue #132) — confirmado testando ao vivo contra homologação com 5
// idAssunto reais (3151, 3243, 3230, 3052, 8411), todos 200. "complemento"
// pode estar ausente (não veio em todos os testes, ex: 3230) — por isso é
// opcional aqui.
interface AssuntoMetadadosVerdeRaw {
  dados?: {
    nome?: string;
    nomeMateria?: string;
    descricao?: string;
    txDocumentosNecessarios?: string;
    urgente?: boolean;
    plantao?: boolean;
    complemento?: { tipo?: string; nome?: string; maximoDiasAteBloqueio?: number | null };
    documentosNecessarios?: { id?: number; nomeDocumento?: string; basico?: boolean }[];
  };
}

// Documento estruturado do array `documentosNecessarios` do Verde (mesmo
// endpoint de /metadados). "basico:true" = obrigatório; false/ausente =
// condicional ("se aplicável" — ex: só se tiver filhos). Ordem preservada
// como o Verde devolve (não reordena obrigatório-primeiro).
function formatarListaDocumentos(docs?: { nomeDocumento?: string; basico?: boolean }[]): string {
  const validos = (docs ?? []).filter(
    (d): d is { nomeDocumento: string; basico?: boolean } => !!d.nomeDocumento
  );
  if (validos.length === 0) {
    return "Nenhum documento específico informado — leve RG e CPF.";
  }
  return validos
    .map((d, i) => `${i + 1}. ${d.nomeDocumento}${d.basico ? " (obrigatório)" : " (se aplicável)"}`)
    .join("\n");
}

export async function assuntoFlowRoutes(app: FastifyInstance) {
  // POST /api/assunto/consultar-item-arvore — { idCategoria?, idItemCategoria? }
  // → { assunto_encontrado, idAssunto, pergunta, respostas, lista }
  // 1ª chamada usa idCategoria (ponto de entrada da árvore pra cada categoria
  // da Maria); chamadas seguintes usam idItemCategoria (resposta escolhida).
  app.post("/api/assunto/consultar-item-arvore", async (req, reply) => {
    const body = (req.body ?? {}) as { idCategoria?: string | number; idItemCategoria?: string | number };
    const idItemCategoria = body.idItemCategoria ? Number(body.idItemCategoria) : null;
    const idCategoria = !idItemCategoria && body.idCategoria ? Number(body.idCategoria) : null;
    if (!idItemCategoria && !idCategoria) {
      console.log(`[assunto] consultar-item-arvore: sem idCategoria/idItemCategoria`);
      return { assunto_encontrado: false, idAssunto: null, pergunta: "", respostas: [], lista: "" };
    }

    const query = idItemCategoria ? `idItemCategoria=${idItemCategoria}` : `idCategoria=${idCategoria}`;
    const resp = await gatewayVerdeGet<ItemArvoreVerdeRaw>(`/api/assunto/consultar-item-arvore?${query}`);
    // BUG-013 (teste manual 2026-08-11): gatewayVerdeGet devolve null tanto
    // pra "sem resposta" quanto pra qualquer erro real (401/timeout/5xx) —
    // sem distinguir, esta rota sempre respondia 200 com pergunta/respostas
    // vazias, e o node `api` do fluxo (que só marca `_erro` em `!res.ok`)
    // nunca via a falha. Usuário caía num loop mudo (pergunta em branco,
    // zero opções) em vez de ver erro/handoff. 502 aqui ativa a edge "erro"
    // já suportada nativamente pelo node `api` do engine.
    if (!resp) {
      console.warn(`[assunto] consultar-item-arvore: ${query} → gateway Verde falhou`);
      return reply.code(502).send({ erro: "gateway_verde_indisponivel" });
    }
    const d = resp.dados;
    const respostas = d?.respostas ?? [];
    const lista = respostas.map((r, i) => `${i + 1}. ${r.resposta}`).join("\n");

    console.log(`[assunto] consultar-item-arvore: ${query} → encontrado=${!!d?.assuntoEncontrado}`);
    return {
      assunto_encontrado: d?.assuntoEncontrado ?? false,
      idAssunto: d?.idAssunto ?? null,
      pergunta: d?.pergunta ?? "",
      respostas,
      lista,
    };
  });

  // POST /api/assunto/resolver-escolha — { escolha_sel, resultado_arvore } → { idItemCategoria }
  // resultado_arvore é o JSON cru que /consultar-item-arvore devolveu (mesma
  // chave de dadosColetados, direto — sem wrapper extra) — resolve o número
  // digitado pro id da resposta escolhida, zero chamada nova ao Verde (mesmo
  // padrão de casos/detalhe, vaga-detalhe).
  app.post("/api/assunto/resolver-escolha", async (req) => {
    const body = (req.body ?? {}) as { escolha_sel?: string; resultado_arvore?: string };
    const sel = String(body.escolha_sel ?? "").trim();

    let respostas: RespostaArvore[] = [];
    try {
      respostas = JSON.parse(body.resultado_arvore ?? "{}")?.respostas ?? [];
    } catch {
      /* segue vazio */
    }

    const idx = /^\d{1,2}$/.exec(sel);
    const escolhida = idx ? respostas[Number(sel) - 1] : respostas.find((r) => r.resposta === sel);

    if (!escolhida?.id) {
      console.log(`[assunto] resolver-escolha: "${sel}" não encontrada`);
      return { encontrada: false, idItemCategoria: null };
    }
    console.log(`[assunto] resolver-escolha: "${sel}" → idItemCategoria=${escolhida.id}`);
    return { encontrada: true, idItemCategoria: escolhida.id };
  });

  // GET /api/assunto/metadados?idAssunto=... — proxy GET api/assunto/{idAssunto}
  // do gateway (issue #132). Decisão de produto: expor urgência e o texto
  // pronto de documentos necessários pro fluxo mostrar ao assistido;
  // "plantao" fica fora de escopo (não expor). Minimização LGPD: não repassa
  // "descricao"/"complemento" (texto livre da matéria, não relevante ainda
  // pro fluxo). O array estruturado "documentosNecessarios" tem uso próprio
  // agora em POST /api/assunto/documentos (abaixo) — não duplicado aqui.
  app.get("/api/assunto/metadados", async (req) => {
    const idAssunto = Number((req.query as { idAssunto?: string | number })?.idAssunto);
    if (!idAssunto) {
      console.log(`[assunto] metadados: idAssunto inválido`);
      return { encontrado: false, urgente: false, documentos_necessarios: null };
    }

    const resp = await gatewayVerdeGet<AssuntoMetadadosVerdeRaw>(`/api/assunto/${idAssunto}`);
    const d = resp?.dados;
    if (!d) {
      console.log(`[assunto] metadados: idAssunto=${idAssunto} → não encontrado`);
      return { encontrado: false, urgente: false, documentos_necessarios: null };
    }

    console.log(`[assunto] metadados: idAssunto=${idAssunto} → urgente=${!!d.urgente}`);
    return {
      encontrado: true,
      urgente: d.urgente ?? false,
      documentos_necessarios: d.txDocumentosNecessarios ?? null,
    };
  });

  // POST /api/assunto/documentos — { idAssunto } → { encontrado, listaDocumentos }
  // Mesmo proxy GET api/assunto/{idAssunto} de /metadados, mas usa o array
  // estruturado "documentosNecessarios" pra montar uma lista numerada
  // distinguindo obrigatório (basico:true) de condicional (basico:false/
  // ausente) — pronta pra interpolar na mensagem de sucesso do agendamento
  // (fluxo "Primeiro Atendimento (Órgão)"). POST (não GET com query) pra
  // casar com o padrão dos outros nodes `api` deste subfluxo
  // (consultar-item-arvore/resolver-escolha), que já leem idAssunto do body.
  app.post("/api/assunto/documentos", async (req) => {
    const body = (req.body ?? {}) as { idAssunto?: string | number };
    const idAssunto = Number(body.idAssunto);
    if (!idAssunto) {
      console.log(`[assunto] documentos: idAssunto inválido`);
      return { encontrado: false, listaDocumentos: formatarListaDocumentos() };
    }

    const resp = await gatewayVerdeGet<AssuntoMetadadosVerdeRaw>(`/api/assunto/${idAssunto}`);
    const d = resp?.dados;
    if (!d) {
      console.log(`[assunto] documentos: idAssunto=${idAssunto} → não encontrado`);
      return { encontrado: false, listaDocumentos: formatarListaDocumentos() };
    }

    console.log(
      `[assunto] documentos: idAssunto=${idAssunto} → ${d.documentosNecessarios?.length ?? 0} documento(s)`
    );
    return { encontrado: true, listaDocumentos: formatarListaDocumentos(d.documentosNecessarios) };
  });
}
