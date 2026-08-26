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
// walk blocks, acumula texto, junta bloco por bloco com \n\n.
// boolean/options NÃO viram mais "(responda Sim ou Não)"/lista "- opção" aqui
// (removido 2026-08-26, pedido do usuário) — essa info já sai estruturada em
// tipoResposta/opcoes (ver tipoEOpcoes() abaixo), a Tykhe monta botão real
// (optionsNode/dynamicOptionsNode) a partir daí; texto duplicado só poluía.
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
    }
    // boolean/options: sem representação textual aqui de propósito (ver nota
    // acima) — só contam pra tipoEOpcoes(). image_url/cta_url: sem
    // representação textual simples — ignorados (mesmo espírito do
    // flushTexto dos outros canais, que só acumula texto).
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

type TipoResposta = "sim_nao" | "opcoes" | "texto";

// Acha a pergunta PENDENTE de verdade pra Tykhe renderizar via dynamicOptionsNode
// (em vez de achatar em texto, ver montarResposta/textoDoConteudo acima) —
// varre `mensagens` da mais recente pra trás e, dentro de cada uma, os blocos
// do content de trás pra frente (último bloco interativo primeiro), porque
// mensagens/blocos anteriores no array costumam ser só texto informativo; a
// pergunta real é o ÚLTIMO bloco boolean/options emitido. Mesmo vocabulário
// de blocos de perguntas.ts (sim_nao → boolean, opcoes → options com
// options: string[]) e do builder do engine (ver core/engine/builder.ts).
function tipoEOpcoes(mensagens: BaseMessage[]): { tipoResposta: TipoResposta; opcoes?: string[] } {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const content = mensagens[i].content;
    if (typeof content === "string") continue;
    const blocos = content as Array<{ type: string; options?: string[] }>;
    for (let j = blocos.length - 1; j >= 0; j--) {
      const b = blocos[j];
      if (b.type === "boolean") return { tipoResposta: "sim_nao", opcoes: ["Sim", "Não"] };
      if (b.type === "options" && b.options?.length) return { tipoResposta: "opcoes", opcoes: b.options };
    }
  }
  return { tipoResposta: "texto" };
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

// Monta dadosColetados pra semear quando a Tykhe já sabe o CPF do assistido
// (consultou direto no Verde, fora do motor da Maria) — sem isso, node
// pp_set_idpessoa (fluxo "Pessoa Presa") lê {{resultado_cpf.dados.idPessoa}}
// vazio e api_encaminhar não acha dadosColetados.cpf, porque essas chaves só
// existem hoje quando o PRÓPRIO motor roda a Consulta CPF (node no_2ulokx,
// POST /api/assistidos/consultar) — a Tykhe nunca passa por ali.
// Grava no MESMO shape que aquele node grava (resultado_cpf = JSON string de
// { encontrado, dados: {...} } — ver core/engine/builder.ts case "api": a
// resposta crua vira string, não objeto; dadosColetados é Record<string,string>
// em state.ts, e resolverCampo/campos.ts já sabe JSON.parse esse formato).
// Só inclui chaves realmente preenchidas (não grava undefined/null por cima
// de nada) e só retorna algo se pelo menos um campo veio.
function dadosIniciaisDeTykhe(d: {
  cpf?: string;
  idPessoa?: number;
  nome?: string;
  email?: string;
}): Record<string, string> | undefined {
  const cpf = typeof d.cpf === "string" && d.cpf.trim() ? d.cpf.trim() : undefined;
  const idPessoa = typeof d.idPessoa === "number" && Number.isFinite(d.idPessoa) ? d.idPessoa : undefined;
  const nome = typeof d.nome === "string" && d.nome.trim() ? d.nome.trim() : undefined;
  const email = typeof d.email === "string" && d.email.trim() ? d.email.trim() : undefined;
  if (cpf === undefined && idPessoa === undefined && nome === undefined && email === undefined) return undefined;

  const dadosResultado: Record<string, unknown> = {};
  if (idPessoa !== undefined) dadosResultado.idPessoa = idPessoa;
  if (nome !== undefined) dadosResultado.nome = nome;
  if (cpf !== undefined) dadosResultado.cpf = cpf;
  if (email !== undefined) dadosResultado.email = email;

  const dadosIniciais: Record<string, string> = {
    resultado_cpf: JSON.stringify({ encontrado: true, dados: dadosResultado }),
  };
  if (cpf !== undefined) dadosIniciais.cpf = cpf;
  return dadosIniciais;
}

export async function tykheMensagemRoutes(app: FastifyInstance) {
  // POST /api/tykhe/mensagem — { chatId, mensagem?, audioUrl?, customerId?,
  // dadosConhecidos?, flowId? } → roda o motor de verdade (LangGraph,
  // processarMensagem em core/chat.ts). dadosConhecidos (cpf/idPessoa/nome/
  // email) só é usado na 1ª chamada de um chatId novo — ver
  // dadosIniciaisDeTykhe() acima.
  // e devolve { resposta, tipoResposta, opcoes?, categoria?, status, migrado }
  // pra Tykhe repassar no WhatsApp e decidir (via changeFlowNode do lado
  // dela) se continua com a Maria ou retoma o fluxo legado. tipoResposta/
  // opcoes (ver tipoEOpcoes() acima) são NOVOS e OPCIONAIS: permitem o lado
  // Tykhe trocar o textNode final por um dynamicOptionsNode (renderiza
  // botões de verdade a partir de uma lista) em vez de achatar sim/não e
  // múltipla escolha em texto puro dentro de `resposta` — que continua sendo
  // enviado sempre, inalterado, pra não quebrar quem só consome ele.
  //
  // chatId da Tykhe = sessionId/thread do LangGraph — precisa ser ESTÁVEL
  // entre chamadas da MESMA conversa (chave de continuidade do checkpoint).
  // Prefixo "tykhe:" isola o thread_id dos outros canais (mesma convenção de
  // wa:/test: já usada em whatsapp.ts/admin.ts) — nunca usar o chatId cru:
  // colidiria com sessões de outro canal se a Tykhe reusar ids.
  //
  // flowId (opcional): roda um fluxo ESPECÍFICO em vez do MariaIA completo —
  // pula saudação/LGPD/CPF/relato quando a Tykhe já fez tudo isso do lado
  // dela e a pessoa já escolheu a categoria num menu (caso "Pessoa Presa").
  // Mesmo mecanismo do chat de teste do painel (/admin/test-chat), via
  // carregarGrafoPorId em core/chat.ts — ver processarMensagem() lá pro
  // contrato exato (só afeta onde a 1ª mensagem de um chatId novo começa;
  // chamadas seguintes do mesmo chatId resumem normal, flowId não reinicia
  // nada). Combina com dadosConhecidos: os dois juntos, na 1ª mensagem.
  // Só precisa ser mandado na 1ª chamada de um chatId novo — processarMensagem()
  // persiste o flowId usado (tabela SessaoFluxo) e reusa automaticamente nas
  // chamadas seguintes mesmo se a Tykhe não reenviar (comportamento real dela:
  // só manda o campo obrigatório na 1ª chamada). Reenviar num chatId já
  // existente troca o flow salvo (troca explícita), não é ignorado.
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
      dadosConhecidos?: { cpf?: string; idPessoa?: number; nome?: string; email?: string };
      flowId?: string;
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
          tipoResposta: "texto" as const,
          status: "em_andamento",
          migrado: false,
        };
      }
    }

    const sessionId = `tykhe:${chatId}`;
    // dadosIniciais só faz efeito no PRIMEIRO invoke de uma thread nova
    // (ver processarMensagem em core/chat.ts — isResuming decide) — chamadas
    // seguintes do mesmo chatId ignoram dadosConhecidos mesmo se vier de novo,
    // sem precisar checar aqui se a thread já existe (evita duplicar o
    // padrão crítico de multi-turn nesta rota).
    const dadosIniciais = dadosIniciaisDeTykhe(body.dadosConhecidos ?? {});
    const flowId = typeof body.flowId === "string" && body.flowId.trim() ? body.flowId.trim() : undefined;
    const { newMessages, status, categoria } = await processarMensagem(
      sessionId,
      mensagem,
      "tykhe",
      dadosIniciais,
      flowId
    );

    return {
      resposta: montarResposta(newMessages),
      ...tipoEOpcoes(newMessages),
      status,
      migrado: ehCategoriaMigrada(categoria),
      ...(categoria ? { categoria } : {}),
    };
  });
}
