import type { FastifyInstance } from "fastify";
import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { processarMensagem } from "../../../core/chat.js";
import { transcreverAudio } from "../../../core/transcribe.js";

// SEM AUTENTICAÇÃO (protótipo/temporário da integração Maria↔Tykhe) — mesmo
// racional de assistidos.ts (ver ali); não subir pra produção sem token.

// Achata os content blocks da Maria (texto | image_url | boolean | options |
// cta_url — ver CLAUDE.md "Tipos de Mensagem Customizados") num texto único.
// Mesmo algoritmo de acumulação de src/core/channels/payloads.ts (WhatsApp) —
// walk blocks, acumula texto, junta bloco por bloco com \n\n — mas sem
// produzir UI interativa: a Tykhe só tem texto simples, então boolean/options
// viram texto plano em vez de botão/lista.
function textoDoConteudo(content: MessageContent): string {
  if (typeof content === "string") return content;
  const blocos = content as Array<{ type: string; text?: string; options?: string[] }>;
  const partes: string[] = [];
  let acumulado = "";
  const flush = () => {
    if (acumulado) partes.push(acumulado);
    acumulado = "";
  };
  for (const b of blocos) {
    if (b.type === "text" && b.text) {
      acumulado += (acumulado ? "\n\n" : "") + b.text;
    } else if (b.type === "boolean") {
      flush();
      partes.push("(responda Sim ou Não)");
    } else if (b.type === "options" && b.options?.length) {
      flush();
      partes.push(b.options.map((o) => `- ${o}`).join("\n"));
    }
    // image_url/cta_url: sem representação textual simples — ignorados aqui
    // (mesmo espírito do flushTexto dos outros canais, que só acumula texto).
  }
  flush();
  return partes.join("\n\n");
}

function montarResposta(mensagens: BaseMessage[]): string {
  return mensagens
    .map((m) => textoDoConteudo(m.content))
    .filter(Boolean)
    .join("\n\n");
}

// Baixa (fetch simples — a Tykhe manda uma URL, não um id de mídia com token
// como o WhatsApp) + transcreve via o MESMO pipeline compartilhado
// (transcreverAudio em core/transcribe.ts, canal-agnóstico — usado pelo
// WhatsApp, que só difere em COMO baixa os bytes). "" em qualquer falha (o
// chamador trata o fallback) — mesmo contrato de transcreverAudioWA.
async function transcreverAudioTykhe(audioUrl: string): Promise<string> {
  try {
    const res = await fetch(audioUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[tykhe] download do áudio falhou HTTP ${res.status}`);
      return "";
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return await transcreverAudio(audio, "tykhe");
  } catch (err) {
    console.error("[tykhe] falha ao processar áudio:", err);
    return "";
  }
}

// Categorias que o Orquestrador (flow "Orquestrador", subfluxo classificar
// no_w6owdo) já tem RECONSTRUÍDAS pra Maria conduzir sozinha — as únicas 2
// hoje: "pessoa_presa" e "violencia_domestica" (valores reais gravados em
// dadosColetados.categoria/state.categoria, conferidos direto no fluxo ativo
// via mcp-maria-flows, 2026-08). Qualquer outra categoria a Tykhe assume de
// volta com o fluxo legado dela (changeFlowNode do lado deles lê `migrado`).
const CATEGORIAS_MIGRADAS = ["pessoa_presa", "violencia_domestica"];

// Normaliza pra comparar tolerante a acento/caixa/separador — o valor real
// hoje é snake_case sem acento ("pessoa_presa"), mas o node de classificar já
// existiu com opções acentuadas ("violência doméstica" nas subtelas/títulos
// do subfluxo) e pode variar; não trava o match numa formatação exata.
function normalizarCategoria(v: string): string {
  return v
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function ehCategoriaMigrada(categoria: string | null): boolean {
  if (!categoria) return false;
  const norm = normalizarCategoria(categoria);
  return CATEGORIAS_MIGRADAS.some((c) => normalizarCategoria(c) === norm);
}

export async function tykheMensagemRoutes(app: FastifyInstance) {
  // POST /api/tykhe/mensagem — { chatId, mensagem?, audioUrl?, customerId? }
  // → roda o motor de verdade (LangGraph, processarMensagem em core/chat.ts)
  // e devolve { resposta, categoria?, status, migrado } pra Tykhe repassar no
  // WhatsApp e decidir (via changeFlowNode do lado dela) se continua com a
  // Maria ou retoma o fluxo legado.
  //
  // chatId da Tykhe = sessionId/thread do LangGraph — precisa ser ESTÁVEL
  // entre chamadas da MESMA conversa (chave de continuidade do checkpoint).
  // Prefixo "tykhe:" isola o thread_id dos outros canais (mesma convenção de
  // wa:/test: já usada em whatsapp.ts/admin.ts) — nunca usar o chatId cru:
  // colidiria com sessões de outro canal se a Tykhe reusar ids.
  //
  // processarMensagem() já centraliza o padrão crítico de multi-turn (thread
  // novo → invoke(estado inicial); resume → updateState + invoke(null)) —
  // esta rota só chama com canal "tykhe", nunca duplica essa lógica aqui.
  app.post("/api/tykhe/mensagem", async (req, reply) => {
    const body = (req.body ?? {}) as {
      chatId?: string;
      mensagem?: string;
      audioUrl?: string;
      customerId?: string;
    };
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    if (!chatId) return reply.code(400).send({ erro: "chatId obrigatório" });

    const mensagemTexto = typeof body.mensagem === "string" ? body.mensagem : "";
    const audioUrl = typeof body.audioUrl === "string" ? body.audioUrl.trim() : "";
    if (!mensagemTexto && !audioUrl) {
      return reply.code(400).send({ erro: "mensagem ou audioUrl obrigatório" });
    }

    let mensagem = mensagemTexto;
    if (!mensagem && audioUrl) {
      mensagem = await transcreverAudioTykhe(audioUrl);
      if (!mensagem) {
        // mesmo fallback amigável do WhatsApp em falha de transcrição — NÃO
        // invoca o motor (estado da conversa fica intocado, igual o outro
        // canal faz quando o áudio não dá pra entender).
        return {
          resposta: montarResposta([
            new AIMessage("Desculpe, não consegui entender o áudio. Pode escrever ou enviar novamente? 🎤"),
          ]),
          status: "em_andamento",
          migrado: false,
        };
      }
    }

    const sessionId = `tykhe:${chatId}`;
    const { newMessages, status, categoria } = await processarMensagem(sessionId, mensagem, "tykhe");

    return {
      resposta: montarResposta(newMessages),
      status,
      migrado: ehCategoriaMigrada(categoria),
      ...(categoria ? { categoria } : {}),
    };
  });
}
