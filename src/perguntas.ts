import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "./state.js";

export type TipoPergunta = "texto" | "sim_nao" | "opcoes" | "cpf" | "telefone" | "cep" | "data";

export interface Pergunta {
  chave: string;            // key em dadosColetados
  texto: string;            // pergunta em linguagem natural
  obrigatoria: boolean;
  tipo: TipoPergunta;
  opcoes?: string[];        // para tipo "opcoes"
  descricao?: string;       // dica para o extrator (vira description no schema do LLM)
  condicao?: (dados: Record<string, string>) => boolean;  // só pergunta se true
  // valida valor extraído por inferência do LLM; inválido → descarta e pergunta normalmente.
  // NÃO se aplica à resposta direta do usuário (evita loop de re-pergunta).
  validar?: (valor: string) => boolean;
}

export function pendentes(perguntas: Pergunta[], dados: Record<string, string>): Pergunta[] {
  return perguntas.filter((p) => !(p.chave in dados) && (p.condicao?.(dados) ?? true));
}

export function proxima(perguntas: Pergunta[], dados: Record<string, string>): Pergunta | undefined {
  return pendentes(perguntas, dados)[0];
}

export function mensagemPergunta(p: Pergunta): AIMessage {
  if (p.tipo === "sim_nao") {
    return new AIMessage({
      content: [
        { type: "text", text: p.texto },
        { type: "boolean", trueLabel: true, falseLabel: false },
      ],
    });
  }
  if (p.tipo === "opcoes" && p.opcoes?.length) {
    return new AIMessage({
      content: [
        { type: "text", text: p.texto },
        { type: "options", options: p.opcoes },
      ],
    });
  }
  return new AIMessage(p.texto);
}

// Factory: node que faz a próxima pergunta pendente do grupo e pausa (interruptAfter no grafo)
export function nodePergunta(perguntas: Pergunta[]) {
  return async (state: GraphState) => {
    const p = proxima(perguntas, state.dadosColetados);
    if (!p) return {};
    return {
      messages: [mensagemPergunta(p)],
      perguntasFeitas: [p.chave],
      ultimaPergunta: p.chave,
    };
  };
}
