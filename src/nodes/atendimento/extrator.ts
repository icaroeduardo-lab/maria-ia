import { ChatBedrockConverse } from "@langchain/aws";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphState } from "../../state.js";
import { proxima, type Pergunta } from "../../perguntas.js";
import { PERGUNTAS_POR_CHAVE, servicoDe, grupoColetaDe } from "../../registro-perguntas.js";

const model = new ChatBedrockConverse({
  model: process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0",
  region: process.env.AWS_REGION ?? "us-east-1",
  temperature: 0,
});

// Campos do CASO, extraíveis de qualquer fala (extração oportunista).
// Dados de identidade/endereço/contato NÃO entram aqui: só são extraídos quando
// a última pergunta é do grupo deles, para não capturar nome/dados de terceiros.
const CAMPOS_CASO: Record<string, string> = {
  tem_filhos: "Se a pessoa tem filhos: 'sim' ou 'não'",
  filhos_menores: "Se algum filho é menor de 18 anos: 'sim' ou 'não'",
  situacao_conjugal: "Situação conjugal: casado(a), solteiro(a), união estável, divorciado(a), viúvo(a)",
  descricao_caso: "Resumo do caso relatado pela pessoa, em uma frase",
};

// Só campos ainda não coletados (menos superfície para alucinação) +
// a última pergunta feita (permite correção da resposta direta)
function montarSchema(categoria: string, dados: Record<string, string>, ultima?: Pergunta) {
  const campos: Record<string, string> = { ...CAMPOS_CASO };
  for (const p of servicoDe(categoria).perguntas) {
    campos[p.chave] = p.descricao ?? p.texto;
  }
  // em coleta de dados, libera os campos do MESMO grupo da pergunta atual
  // (ex: respondendo o CEP, pode informar cidade/bairro/rua junto)
  const grupo = ultima ? grupoColetaDe(ultima.chave) : undefined;
  for (const p of grupo ?? []) {
    campos[p.chave] = p.descricao ?? p.texto;
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [chave, descricao] of Object.entries(campos)) {
    if (chave in dados && chave !== ultima?.chave) continue;
    shape[chave] = z.string().nullish().describe(descricao);
  }
  return z.object(shape);
}

function textoDe(m: BaseMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && "type" in b && b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

// campos globais que são sim/não mas não pertencem a nenhum grupo de perguntas
const GLOBAIS_SIM_NAO = new Set(["tem_filhos", "filhos_menores"]);

function normalizarSimNao(valor: string): string {
  const v = valor.trim().toLowerCase();
  if (v === "true" || v.startsWith("s")) return "sim";
  if (v === "false" || v.startsWith("n")) return "não";
  return valor;
}

// Placeholders que o LLM inventa quando não sabe — nunca são dados reais
const PLACEHOLDER = /unknown|n\/a|^null$|undefined|não informado|nao informado|<.+>|^[-?.]+$/i;

// Se o valor extraído corresponde a uma das opções da pergunta, normaliza para o
// rótulo oficial; senão devolve undefined (valor inventado/incompatível)
function casarOpcao(p: Pergunta, valor: string): string | undefined {
  const v = valor.trim().toLowerCase();
  return p.opcoes?.find((o) => o.toLowerCase() === v || o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
}

// Roda após cada resposta do usuário: extrai campos da conversa para dadosColetados.
// Evita perguntar o que já foi respondido implicitamente.
export async function extrator(state: GraphState) {
  const lastHuman = state.messages.findLast((m) => m.getType() === "human");
  const msg = lastHuman ? textoDe(lastHuman).trim() : "";
  const dados = state.dadosColetados;
  const ultima = state.ultimaPergunta ? PERGUNTAS_POR_CHAVE.get(state.ultimaPergunta) : undefined;

  const updates: Record<string, string> = {};

  // 1. Extração via LLM (structured output) — SÓ sobre a última mensagem do usuário.
  //    Cada mensagem é processada uma única vez, no turno em que chega; mandar o
  //    histórico de novo só confunde o modelo (ex: pegar nome de terceiro como nome do usuário).
  try {
    if (!msg) throw new Error("sem mensagem do usuário");

    const system = `Você extrai dados estruturados da fala de um usuário em atendimento jurídico da Defensoria Pública.

Regras:
- Extraia APENAS o que o usuário AFIRMOU explicitamente na fala abaixo.
- NUNCA deduza, suponha ou invente. Em dúvida, deixe null.
- Campos sim/não: só preencha se o usuário respondeu ou afirmou isso claramente. Use exatamente "sim" ou "não".
- Datas e números: transcreva como o usuário informou.`;

    const contextoPergunta = ultima ? `Pergunta da atendente: "${ultima.texto}"\n\n` : "";
    const schema = montarSchema(state.categoria, dados, ultima);
    const extraido = await model.withStructuredOutput(schema).invoke([
      new SystemMessage(system),
      new HumanMessage(`${contextoPergunta}Fala do usuário: "${msg}"\n\nExtraia os dados informados.`),
    ]);

    for (const [chave, valor] of Object.entries(extraido)) {
      if (typeof valor !== "string" || !valor.trim()) continue;
      if (PLACEHOLDER.test(valor.trim())) continue;
      const p = PERGUNTAS_POR_CHAVE.get(chave);
      const ehSimNao = p?.tipo === "sim_nao" || GLOBAIS_SIM_NAO.has(chave);
      const ehRespostaDireta = chave === ultima?.chave;
      // "true"/"false" de clique de botão nunca vale para campo de texto
      if (!ehSimNao && ["true", "false"].includes(valor.trim().toLowerCase())) continue;
      // sim/não de pergunta de serviço só vale como resposta direta — Haiku chuta
      // "sim"/"não" para perguntas que ainda nem foram feitas (ex: ja_existe_processo)
      if (ehSimNao && !ehRespostaDireta && !GLOBAIS_SIM_NAO.has(chave)) continue;
      // valor inferido que não passa na validação da pergunta → descarta (será perguntado)
      if (!ehRespostaDireta && p?.validar && !p.validar(valor)) continue;
      if (p?.tipo === "opcoes") {
        const oficial = casarOpcao(p, valor);
        if (oficial) updates[chave] = oficial;
        else if (ehRespostaDireta) updates[chave] = valor.trim();
        continue;
      }
      updates[chave] = ehSimNao ? normalizarSimNao(valor) : valor.trim();
    }
  } catch (err) {
    console.error("[extrator] falha na extração LLM:", err);
  }

  // 2. Resposta direta de botão/lista tem precedência sobre o LLM
  if (ultima && msg) {
    if (ultima.tipo === "sim_nao" && (msg === "true" || msg === "false")) {
      updates[ultima.chave] = msg === "true" ? "sim" : "não";
    } else if (ultima.tipo === "opcoes" && ultima.opcoes?.includes(msg)) {
      updates[ultima.chave] = msg;
    }
  }

  // 3. Fallback anti-loop: pergunta feita sem valor extraído → guarda a resposta bruta
  // ("true"/"false" solto fora de pergunta sim/não é clique perdido — descarta)
  if (ultima && msg && !(ultima.chave in dados) && !(ultima.chave in updates)) {
    if (ultima.tipo === "sim_nao") {
      updates[ultima.chave] = normalizarSimNao(msg);
    } else if (!["true", "false"].includes(msg.toLowerCase())) {
      updates[ultima.chave] = msg;
    }
  }

  const dadosFinais = { ...dados, ...updates };
  const servicoConcluido = !proxima(servicoDe(state.categoria).perguntas, dadosFinais);

  return { dadosColetados: updates, servicoConcluido };
}
