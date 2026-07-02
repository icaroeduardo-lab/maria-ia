import type { GraphState } from "../../state.js";
import { enviarParaDPERJ, type PayloadDPERJ } from "../../dperj.js";

const CAMPOS_PESSOAIS = ["nome", "cpf", "data_nascimento", "telefone", "email"] as const;
const CAMPOS_RESIDENCIAIS = ["cep", "rua", "numero", "bairro", "cidade"] as const;

function montarPayload(state: GraphState): PayloadDPERJ {
  const dados = state.dadosColetados;
  const pegar = (chaves: readonly string[]) =>
    Object.fromEntries(chaves.filter((c) => c in dados).map((c) => [c, dados[c]]));

  const especificos = Object.fromEntries(
    Object.entries(dados).filter(
      ([c]) => !CAMPOS_PESSOAIS.includes(c as never) && !CAMPOS_RESIDENCIAIS.includes(c as never)
    )
  );

  return {
    canal: state.canal === "whatsapp" ? "whatsapp" : "web",
    categoria: state.categoria,
    timestamp_inicio: state.iniciadoEm,
    timestamp_fim: new Date().toISOString(),
    dados_pessoais: pegar(CAMPOS_PESSOAIS),
    dados_residenciais: { ...pegar(CAMPOS_RESIDENCIAIS), estado: "RJ" },
    dados_caso: especificos,
  };
}

// Roda quando todas as perguntas foram respondidas, antes do encerramento.
// API indisponível → payload vai para a fila de retry e o protocolo fica vazio.
export async function enviarDados(state: GraphState) {
  const protocolo = await enviarParaDPERJ(montarPayload(state));
  return { protocolo: protocolo ?? "" };
}
