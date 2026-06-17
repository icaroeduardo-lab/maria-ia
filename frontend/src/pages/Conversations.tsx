import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";

interface Conversa {
  sessionId: string;
  channel: string;
  status: string;
  categoria: string | null;
  ultimaEtapa: string | null;
  protocoloDperj: string | null;
  startedAt: string;
}

interface ConversaDetalhe extends Conversa {
  resumo: string | null;
  metadados: Metadados | null;
  dadosColetados: Record<string, unknown>;
}

interface Metadados {
  categoria: string | null;
  assistido: Record<string, string | null>;
  caso: Record<string, string>;
  relato: string;
  encaminhamento?: Record<string, unknown>;
  protocolo: string | null;
}

const CORES: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800",
  active: "bg-sky-100 text-sky-800",
  abandoned: "bg-red-100 text-red-700",
};

export function Conversations() {
  const [status, setStatus] = useState("");
  const [aberta, setAberta] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["conversations", status],
    queryFn: () => api<{ total: number; itens: Conversa[] }>(`/admin/conversations${status ? `?status=${status}` : ""}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold">Conversas</h1>
        <select
          className="border border-slate-300 rounded px-2 py-1 bg-white text-sm"
          value={status} onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">todas</option>
          <option value="active">ativas</option>
          <option value="completed">concluídas</option>
          <option value="abandoned">abandonadas</option>
        </select>
        <span className="text-sm text-slate-500">{data?.total ?? 0} conversas</span>
      </div>

      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500 border-b border-slate-200">
            <tr>
              {["Sessão", "Canal", "Status", "Categoria", "Etapa", "Protocolo", "Início"].map((h) => (
                <th key={h} className="px-4 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.itens.map((c) => (
              <tr key={c.sessionId} className="hover:bg-slate-50 cursor-pointer" onClick={() => setAberta(c.sessionId)}>
                <td className="px-4 py-2 font-mono text-xs">{c.sessionId}</td>
                <td className="px-4 py-2">{c.channel}</td>
                <td className="px-4 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${CORES[c.status] ?? ""}`}>{c.status}</span>
                </td>
                <td className="px-4 py-2">{c.categoria ?? "—"}</td>
                <td className="px-4 py-2">{c.ultimaEtapa ?? "—"}</td>
                <td className="px-4 py-2">{c.protocoloDperj ?? "—"}</td>
                <td className="px-4 py-2">{new Date(c.startedAt).toLocaleString("pt-BR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aberta && <Detalhe sessionId={aberta} onClose={() => setAberta(null)} />}
    </div>
  );
}

type Aba = "resumo" | "dados" | "historico";
type Bloco = { type: string; text?: string; options?: string[]; image_url?: { url: string } };
interface MsgHist { role: string; content: string | Bloco[] }

// renderiza os blocos da mensagem; imagem fixa (imagens/) aparece, ficha (fichas/, efêmera) vira texto
function renderHistorico(content: MsgHist["content"]) {
  const blocos: Bloco[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return blocos.map((b, i) => {
    if (b.type === "text") return b.text ? <span key={i} className="whitespace-pre-wrap">{b.text}</span> : null;
    if (b.type === "options") return <span key={i} className="opacity-70">[opções: {(b.options ?? []).join(", ")}]</span>;
    if (b.type === "boolean") return <span key={i} className="opacity-70"> [Sim/Não]</span>;
    if (b.type === "image_url") {
      const url = b.image_url?.url ?? "";
      return url.includes("/fichas/")
        ? <span key={i} className="opacity-70">🗎 [ficha do assistido]</span>
        : <img key={i} src={url} className="max-w-[140px] rounded mt-1" alt="" />;
    }
    return null;
  });
}

function temConteudo(content: MsgHist["content"]): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return content.some((b) => (b.type === "text" && b.text?.trim()) || b.type !== "text");
}

function Detalhe({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [aba, setAba] = useState<Aba>("resumo");
  const [full, setFull] = useState<Record<string, string | null> | null>(null);
  const [revelando, setRevelando] = useState(false);

  async function revelar() {
    if (full) { setFull(null); return; } // ocultar
    setRevelando(true);
    try {
      const r = await api<{ assistido: Record<string, string | null> | null }>(
        `/admin/conversations/${encodeURIComponent(sessionId)}/revelar`,
        { method: "POST" }
      );
      setFull(r.assistido);
    } catch { /* sem permissão / erro */ }
    finally { setRevelando(false); }
  }
  const { data: c } = useQuery({
    queryKey: ["conversation", sessionId],
    queryFn: () => api<ConversaDetalhe>(`/admin/conversations/${encodeURIComponent(sessionId)}`),
  });
  const { data: hist } = useQuery({
    queryKey: ["conversation-historico", sessionId],
    queryFn: () => api<{ messages: MsgHist[] }>(`/admin/conversations/${encodeURIComponent(sessionId)}/historico`),
    enabled: aba === "historico",
  });
  const m = c?.metadados;

  const TABS: [Aba, string][] = [["resumo", "Resumo"], ["dados", "Dados do assistido"], ["historico", "Histórico do chat"]];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-lg font-bold text-slate-800">Atendimento</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        {/* guias */}
        <div className="flex gap-1 px-5 border-b border-slate-200 mt-3">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={`px-3 py-2 text-sm border-b-2 -mb-px ${aba === id ? "border-emerald-600 text-emerald-700 font-medium" : "border-transparent text-slate-500 hover:text-slate-700"}`}
              onClick={() => setAba(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="p-5 overflow-y-auto">
          {!c && <p className="text-slate-400 text-sm">Carregando…</p>}

          {aba === "resumo" && c && (
            c.resumo
              ? <p className="text-sm text-slate-800 bg-slate-50 rounded p-3 whitespace-pre-wrap">{c.resumo}</p>
              : <p className="text-sm text-slate-400">Sem resumo (conversa em andamento ou anterior ao recurso).</p>
          )}

          {aba === "dados" && (
            <>
              {m?.assistido && (
                <section className="mb-4">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-xs font-semibold text-slate-500 uppercase">Assistido</h3>
                    <button className="text-xs text-emerald-700 hover:underline disabled:opacity-50" disabled={revelando} onClick={revelar}>
                      {full ? "🙈 ocultar dados" : revelando ? "..." : "👁 revelar dados"}
                    </button>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {Object.entries(full ?? m.assistido).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}>
                        <dt className="inline text-slate-500">{k}: </dt>
                        <dd className="inline text-slate-800 font-mono">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {full && <p className="text-xs text-amber-600 mt-1">Dados revelados — acesso registrado.</p>}
                </section>
              )}
              {m?.caso && Object.keys(m.caso).length > 0 && (
                <section className="mb-4">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase mb-1">Caso ({m.categoria})</h3>
                  <dl className="text-sm space-y-1">
                    {Object.entries(m.caso).map(([k, v]) => (
                      <div key={k}><dt className="inline text-slate-500">{k}: </dt><dd className="inline text-slate-800">{v}</dd></div>
                    ))}
                  </dl>
                </section>
              )}
              {m?.encaminhamento && (
                <section>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase mb-1">Encaminhamento</h3>
                  <pre className="text-xs bg-slate-50 rounded p-2 overflow-x-auto">{JSON.stringify(m.encaminhamento, null, 2)}</pre>
                </section>
              )}
              {!m && <p className="text-sm text-slate-400">Sem dados estruturados.</p>}
            </>
          )}

          {aba === "historico" && (
            <div className="flex flex-col gap-2">
              {!hist && <p className="text-sm text-slate-400">Carregando histórico…</p>}
              {hist?.messages.length === 0 && <p className="text-sm text-slate-400">Sem histórico disponível.</p>}
              {hist?.messages.map((msg, i) => {
                const ai = msg.role === "ai";
                if (!temConteudo(msg.content)) return null;
                return (
                  <div key={i} className={`flex ${ai ? "justify-start" : "justify-end"}`}>
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm ${ai ? "bg-slate-100 text-slate-800" : "bg-emerald-600 text-white"}`}>
                      {renderHistorico(msg.content)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
