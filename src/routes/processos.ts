import type { FastifyInstance } from "fastify";
import { consultarPorCpf, consultarPorNumero, resumirProcesso, listaNumerada } from "../processos.js";

// Rotas internas chamadas pelos nós "api" do fluxo (mesmo padrão do /mock).
// Sem auth: só o engine chama via SELF_URL.
export async function processosRoutes(app: FastifyInstance) {
  // POST /api/processos/consultar { cpf } → lista os processos do CPF
  // Resposta enxuta (cabe no estado do grafo sem truncar): o detalhe rico
  // é buscado de novo no /resumo pelo número escolhido.
  app.post("/api/processos/consultar", async (req) => {
    const { cpf } = (req.body ?? {}) as { cpf?: string };
    const processos = await consultarPorCpf(cpf ?? "");
    const compactos = processos.map((p) => ({ numero: p.numero, assunto: p.assunto, ativo: p.ativo }));
    console.log(`[pdpj] consultar CPF ${cpf} → ${processos.length} processo(s)`);
    return {
      tem_processo: processos.length > 0,
      processos: compactos,
      lista: listaNumerada(processos),
    };
  });

  // POST /api/processos/resumo { processo_sel | numero, processos? } → resumo IA
  // processo_sel pode ser o número completo OU o índice (1, 2, ...) da lista.
  app.post("/api/processos/resumo", async (req) => {
    const body = (req.body ?? {}) as { processo_sel?: string; numero?: string; processos?: string };
    const sel = String(body.numero ?? body.processo_sel ?? "").trim();

    // resolve índice ("2") → número, usando a lista guardada no estado
    let numero = sel;
    try {
      const lista = JSON.parse(body.processos ?? "{}")?.processos as { numero: string }[] | undefined;
      const idx = /^\d{1,2}$/.exec(sel);
      if (idx && lista?.[Number(sel) - 1]) numero = lista[Number(sel) - 1].numero;
    } catch { /* segue com sel */ }

    const proc = await consultarPorNumero(numero);
    if (!proc) {
      console.warn(`[pdpj] resumo: processo ${numero} não encontrado`);
      return { resumo: "Não consegui carregar os detalhes desse processo agora. Pode tentar de novo mais tarde? 🙏", numero };
    }
    const resumo = await resumirProcesso(proc);
    console.log(`[pdpj] resumo gerado para ${numero}`);
    return { resumo, numero };
  });
}
