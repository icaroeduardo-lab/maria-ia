import type { FastifyInstance } from "fastify";
import { gatewayVerdeGet } from "../../core/gateway-verde.js";

// Rotas de identificação de assunto (card Coilab #20260185) — navega a
// árvore de assuntos real do Verde (assunto/categorias → consultar-item-
// arvore, recursivo) até achar um idAssunto concreto. A árvore tem vários
// níveis de pergunta (não é categoria→id direto, confirmado testando ao
// vivo: Divórcio/Pensão levam 3+ níveis) — por isso o subfluxo "Identificar
// Assunto" no builder visual chama esta rota em loop, uma pergunta por vez.

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

export async function assuntoFlowRoutes(app: FastifyInstance) {
  // POST /api/assunto/consultar-item-arvore — { idCategoria?, idItemCategoria? }
  // → { assunto_encontrado, idAssunto, pergunta, respostas, lista }
  // 1ª chamada usa idCategoria (ponto de entrada da árvore pra cada categoria
  // da Maria); chamadas seguintes usam idItemCategoria (resposta escolhida).
  app.post("/api/assunto/consultar-item-arvore", async (req) => {
    const body = (req.body ?? {}) as { idCategoria?: string | number; idItemCategoria?: string | number };
    const idItemCategoria = body.idItemCategoria ? Number(body.idItemCategoria) : null;
    const idCategoria = !idItemCategoria && body.idCategoria ? Number(body.idCategoria) : null;
    if (!idItemCategoria && !idCategoria) {
      console.log(`[assunto] consultar-item-arvore: sem idCategoria/idItemCategoria`);
      return { assunto_encontrado: false, idAssunto: null, pergunta: "", respostas: [], lista: "" };
    }

    const query = idItemCategoria ? `idItemCategoria=${idItemCategoria}` : `idCategoria=${idCategoria}`;
    const resp = await gatewayVerdeGet<ItemArvoreVerdeRaw>(`/api/assunto/consultar-item-arvore?${query}`);
    const d = resp?.dados;
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
    } catch { /* segue vazio */ }

    const idx = /^\d{1,2}$/.exec(sel);
    const escolhida = idx ? respostas[Number(sel) - 1] : respostas.find((r) => r.resposta === sel);

    if (!escolhida?.id) {
      console.log(`[assunto] resolver-escolha: "${sel}" não encontrada`);
      return { encontrada: false, idItemCategoria: null };
    }
    console.log(`[assunto] resolver-escolha: "${sel}" → idItemCategoria=${escolhida.id}`);
    return { encontrada: true, idItemCategoria: escolhida.id };
  });
}
