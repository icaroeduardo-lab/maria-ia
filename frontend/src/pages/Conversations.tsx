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

const CORES: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800",
  active: "bg-sky-100 text-sky-800",
  abandoned: "bg-red-100 text-red-700",
};

export function Conversations() {
  const [status, setStatus] = useState("");
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
              <tr key={c.sessionId}>
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
    </div>
  );
}
