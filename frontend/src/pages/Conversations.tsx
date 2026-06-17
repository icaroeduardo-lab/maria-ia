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
  ficha_url: string | null;
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

function Detalhe({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { data: c } = useQuery({
    queryKey: ["conversation", sessionId],
    queryFn: () => api<ConversaDetalhe>(`/admin/conversations/${encodeURIComponent(sessionId)}`),
  });
  const m = c?.metadados;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-800">Atendimento</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        {!c && <p className="text-slate-400 text-sm">Carregando…</p>}

        {c?.resumo && (
          <section className="mb-4">
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-1">Resumo</h3>
            <p className="text-sm text-slate-800 bg-slate-50 rounded p-3 whitespace-pre-wrap">{c.resumo}</p>
          </section>
        )}

        {m?.assistido && (
          <section className="mb-4">
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-1">Assistido</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {Object.entries(m.assistido).filter(([, v]) => v).map(([k, v]) => (
                <div key={k}><dt className="inline text-slate-500">{k}: </dt><dd className="inline text-slate-800">{v}</dd></div>
              ))}
            </dl>
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
          <section className="mb-4">
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-1">Encaminhamento</h3>
            <pre className="text-xs bg-slate-50 rounded p-2 overflow-x-auto">{JSON.stringify(m.encaminhamento, null, 2)}</pre>
          </section>
        )}

        <div className="flex gap-3 text-sm">
          {m?.ficha_url && <a className="text-emerald-700 hover:underline" href={m.ficha_url} target="_blank" rel="noreferrer">Ver ficha 🖼️</a>}
        </div>

        {!c?.resumo && c && (
          <p className="text-sm text-slate-400">Conversa sem resumo (ainda em andamento ou anterior a este recurso).</p>
        )}
      </div>
    </div>
  );
}
