import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../store";

interface Log {
  id: string;
  userEmail: string;
  acao: string;
  alvoTipo: string;
  alvoId: string;
  criadoEm: string;
}

const ALVO: Record<string, string> = { assistido: "Assistido", conversa: "Conversa" };

export function Auditoria() {
  const { usuario } = useAuth();
  const [page, setPage] = useState(1);
  const { data, isError } = useQuery({
    queryKey: ["audit", page],
    queryFn: () => api<{ total: number; page: number; itens: Log[] }>(`/admin/audit?page=${page}`),
  });

  if (usuario?.role !== "admin") {
    return <p className="text-sm text-slate-500">Acesso restrito a administradores.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Auditoria de acesso</h1>
        <span className="text-sm text-slate-500">{data?.total ?? 0} registros</span>
      </div>
      <p className="text-sm text-slate-500">Registro de quem revelou dados sensíveis (PII) e quando.</p>

      {isError && <p className="text-sm text-red-600">Falha ao carregar.</p>}

      <div className="bg-white rounded-xl shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500 border-b border-slate-200">
            <tr>
              {["Data/hora", "Usuário", "Ação", "Tipo", "Alvo"].map((h) => (
                <th key={h} className="px-4 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.itens.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">Nenhum acesso registrado.</td></tr>
            )}
            {data?.itens.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2">{new Date(l.criadoEm).toLocaleString("pt-BR")}</td>
                <td className="px-4 py-2">{l.userEmail}</td>
                <td className="px-4 py-2">{l.acao}</td>
                <td className="px-4 py-2">{ALVO[l.alvoTipo] ?? l.alvoTipo}</td>
                <td className="px-4 py-2 font-mono text-xs">{l.alvoId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > 50 && (
        <div className="flex gap-2 text-sm">
          <button className="border rounded px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
          <span className="px-2 py-1">página {page}</span>
          <button className="border rounded px-3 py-1 disabled:opacity-40" disabled={page * 50 >= data.total} onClick={() => setPage((p) => p + 1)}>Próxima</button>
        </div>
      )}
    </div>
  );
}
