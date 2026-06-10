import { ChatBedrockConverse } from "@langchain/aws";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphState } from "../state.js";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const CAMPOS = [
  { chave: "nome",     pergunta: "Qual é o seu nome completo?" },
  { chave: "cpf",      pergunta: "Qual é o seu CPF?" },
  { chave: "descricao", pergunta: "Me conte brevemente o que aconteceu e o que você precisa." },
];

const SYSTEM_EXTRATOR = `Você é um extrator de dados.
O usuário acabou de responder a uma pergunta de cadastro. Extraia apenas o valor informado, sem explicações.
Retorne somente o valor limpo. Ex: se perguntou CPF e usuário disse "meu cpf é 123.456.789-00", retorne apenas "123.456.789-00".`;

export async function familiaPensao(state: GraphState) {
  const dados = state.dadosColetados;

  // Descobre qual foi a última pergunta feita (campo pendente anterior)
  const campoAnterior = CAMPOS.find((c) => dados[c.chave] === undefined &&
    state.messages.some((m) => typeof m.content === "string" && m.content.includes(c.pergunta)));

  // Se há campo anterior pendente, extrai o valor da resposta do usuário
  if (campoAnterior) {
    const lastHuman = state.messages.findLast((m) => m instanceof HumanMessage);
    const resposta = typeof lastHuman?.content === "string" ? lastHuman.content : "";

    const extracao = await model.invoke([
      new SystemMessage(SYSTEM_EXTRATOR),
      new HumanMessage(`Pergunta: ${campoAnterior.pergunta}\nResposta do usuário: ${resposta}`),
    ]);

    const valor = typeof extracao.content === "string" ? extracao.content.trim() : resposta;
    return {
      dadosColetados: { [campoAnterior.chave]: valor },
    };
  }

  // Próximo campo ainda não preenchido
  const proximoCampo = CAMPOS.find((c) => !dados[c.chave]);

  if (proximoCampo) {
    return {
      messages: [new AIMessage(proximoCampo.pergunta)],
    };
  }

  // Todos os campos preenchidos — sinaliza via dadosColetados
  return { dadosColetados: { _concluido: "true" } };
}

export function familiaPensaoRoute(state: GraphState) {
  return state.dadosColetados["_concluido"] === "true" ? "informativo" : "__end__";
}
