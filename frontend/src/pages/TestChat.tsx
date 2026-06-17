import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface FlowResumo {
  id: string;
  name: string;
  active: boolean;
}

interface ContentBlock {
  type: "text" | "boolean" | "options" | "image_url";
  text?: string;
  trueLabel?: string | boolean;
  falseLabel?: string | boolean;
  options?: string[];
  image_url?: { url: string };
}

interface Mensagem {
  role: string;
  content: string | ContentBlock[];
}

function renderContent(content: string | ContentBlock[], onImgLoad?: () => void) {
  if (typeof content === "string") return <span className="whitespace-pre-wrap">{content}</span>;
  return (
    <>
      {content.map((block, i) => {
        if (block.type === "text") return <span key={i} className="whitespace-pre-wrap">{block.text}</span>;
        // onLoad rola pro fim quando a imagem termina de carregar (altura muda)
        if (block.type === "image_url") return <img key={i} src={block.image_url?.url} className="max-w-xs rounded mt-1" alt="" onLoad={onImgLoad} />;
        return null;
      })}
    </>
  );
}

function extrairBotoes(content: string | ContentBlock[]) {
  if (typeof content === "string") return {};
  return {
    boolean: content.find((b) => b.type === "boolean"),
    options: content.find((b) => b.type === "options"),
  };
}

export function TestChat() {
  const { data: flows } = useQuery({
    queryKey: ["flows"],
    queryFn: () => api<FlowResumo[]>("/admin/flows"),
  });

  const [flowId, setFlowId] = useState<string>("__static__");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [input, setInput] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [iniciado, setIniciado] = useState(false);
  const [concluido, setConcluido] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [dadosColetados, setDadosColetados] = useState<Record<string, unknown>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const rolarParaFim = () => bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  useEffect(() => {
    rolarParaFim();
  }, [mensagens, carregando]);

  function resetar(novoFlowId?: string) {
    setSessionId(crypto.randomUUID());
    setMensagens([]);
    setIniciado(false);
    setConcluido(false);
    setErro(null);
    setInput("");
    setDadosColetados({});
    if (novoFlowId !== undefined) setFlowId(novoFlowId);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function enviar(texto?: string) {
    const msg = texto ?? input.trim();
    if (carregando || concluido) return;
    if (msg && iniciado) {
      setMensagens((prev) => [...prev, { role: "human", content: msg }]);
    }
    setInput("");
    setCarregando(true);
    setErro(null);

    try {
      const data = await api<{ messages: Mensagem[]; done: boolean; dadosColetados: Record<string, unknown> }>("/admin/test-chat", {
        method: "POST",
        body: JSON.stringify({
          flowId: flowId === "__static__" ? undefined : flowId,
          sessionId,
          message: msg || undefined,
        }),
      });
      if (data.messages?.length) {
        setMensagens((prev) => [...prev, ...data.messages]);
      }
      if (data.dadosColetados) setDadosColetados(data.dadosColetados);
      setIniciado(true);
      if (data.done) setConcluido(true);
    } catch (err) {
      setErro(String(err));
    } finally {
      setCarregando(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  const ultimaAI = [...mensagens].reverse().find((m) => m.role === "ai");
  const { boolean: boolBlock, options: optsBlock } = ultimaAI ? extrairBotoes(ultimaAI.content) : {};
  const mostrarBotoes = !carregando && !concluido && (boolBlock || optsBlock);

  const entradas = Object.entries(dadosColetados);

  return (
    <div className="flex gap-4 h-[calc(100vh-130px)]">
    <div className="flex flex-col flex-1 min-w-0 max-w-xl">
      {/* toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <select
          className="border rounded px-2 py-1.5 text-sm flex-1 bg-white"
          value={flowId}
          onChange={(e) => resetar(e.target.value)}
          disabled={carregando}
        >
          <option value="__static__">Fluxo estático (padrão DPERJ)</option>
          {flows?.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}{f.active ? " ✓ ativo" : ""}
            </option>
          ))}
        </select>
        <button
          className="border rounded px-3 py-1.5 text-sm bg-white hover:bg-gray-50 disabled:opacity-40"
          onClick={() => resetar()}
          disabled={carregando}
          title="Reiniciar conversa"
        >
          ↺ Reiniciar
        </button>
      </div>

      {/* bolhas */}
      <div className="flex-1 overflow-y-auto bg-[#ece5dd] rounded-xl p-4 flex flex-col gap-2 min-h-0">
        {mensagens.length === 0 && !carregando && (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm gap-2 select-none">
            <span className="text-5xl">💬</span>
            <span>Selecione um fluxo e clique em <strong>Iniciar</strong></span>
          </div>
        )}

        {mensagens.map((m, i) => {
          const isAI = m.role === "ai";
          return (
            <div key={i} className={`flex ${isAI ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm shadow-sm leading-relaxed ${
                  isAI ? "bg-white text-gray-800 rounded-tl-sm" : "bg-[#dcf8c6] text-gray-800 rounded-tr-sm"
                }`}
              >
                {renderContent(m.content, rolarParaFim)}
              </div>
            </div>
          );
        })}

        {carregando && (
          <div className="flex justify-start">
            <div className="bg-white px-4 py-2 rounded-2xl rounded-tl-sm shadow-sm text-gray-400 text-sm">
              <span className="animate-pulse">•••</span>
            </div>
          </div>
        )}

        {concluido && (
          <div className="flex justify-center mt-2">
            <span className="text-xs text-gray-500 bg-white/70 rounded-full px-3 py-1">
              Conversa encerrada — clique em ↺ para reiniciar
            </span>
          </div>
        )}

        {erro && (
          <div className="flex justify-center mt-1">
            <span className="text-xs text-red-600 bg-red-50 rounded px-3 py-1">{erro}</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* quick-replies */}
      {mostrarBotoes && (
        <div className="flex flex-wrap gap-2 pt-2">
          {boolBlock && (
            <>
              <button
                onClick={() => enviar(boolBlock.trueLabel === true ? "Sim" : String(boolBlock.trueLabel))}
                className="bg-emerald-600 text-white text-sm px-4 py-1.5 rounded-full hover:bg-emerald-700 transition-colors"
              >
                {boolBlock.trueLabel === true ? "Sim" : String(boolBlock.trueLabel)}
              </button>
              <button
                onClick={() => enviar(boolBlock.falseLabel === false ? "Não" : String(boolBlock.falseLabel))}
                className="bg-white border border-gray-300 text-gray-700 text-sm px-4 py-1.5 rounded-full hover:bg-gray-50 transition-colors"
              >
                {boolBlock.falseLabel === false ? "Não" : String(boolBlock.falseLabel)}
              </button>
            </>
          )}
          {optsBlock?.options?.map((opt, i) => (
            <button
              key={i}
              onClick={() => enviar(opt)}
              className="bg-white border border-emerald-500 text-emerald-700 text-sm px-3 py-1 rounded-full hover:bg-emerald-50 transition-colors"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {/* input */}
      <div className="flex gap-2 mt-2">
        {!iniciado ? (
          <button
            className="flex-1 bg-emerald-600 text-white py-2.5 rounded-xl font-medium hover:bg-emerald-700 transition-colors disabled:opacity-40"
            onClick={() => enviar("")}
            disabled={carregando}
          >
            Iniciar conversa
          </button>
        ) : (
          <>
            <input
              ref={inputRef}
              className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:bg-gray-50"
              placeholder={concluido ? "Conversa encerrada" : "Digite uma mensagem..."}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  enviar();
                }
              }}
              disabled={carregando || concluido}
              autoFocus
            />
            <button
              className="bg-emerald-600 text-white px-4 py-2 rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-40"
              onClick={() => enviar()}
              disabled={carregando || concluido || !input.trim()}
            >
              Enviar
            </button>
          </>
        )}
      </div>
    </div>

    {/* painel de estado — dados coletados + respostas de API */}
    <aside className="w-72 shrink-0 bg-white rounded-xl shadow p-4 overflow-y-auto flex flex-col gap-2">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Dados coletados</p>
      {entradas.length === 0 ? (
        <p className="text-xs text-slate-400">Nenhum dado ainda.</p>
      ) : (
        entradas.map(([chave, valor]) => (
          <div key={chave} className="border rounded p-2 text-xs break-all">
            <p className="font-medium text-slate-600">{chave}</p>
            <p className="text-slate-800 mt-0.5 whitespace-pre-wrap">
              {typeof valor === "object" ? JSON.stringify(valor, null, 2) : String(valor)}
            </p>
          </div>
        ))
      )}
    </aside>
    </div>
  );
}
