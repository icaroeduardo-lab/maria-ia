import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../lib/api";

interface FlowResumo {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

export function Flows() {
  const qc = useQueryClient();
  const [nome, setNome] = useState("");
  const { data: flows } = useQuery({
    queryKey: ["flows"],
    queryFn: () => api<FlowResumo[]>("/admin/flows"),
  });

  const invalidar = () => qc.invalidateQueries({ queryKey: ["flows"] });
  const criar = useMutation({
    mutationFn: () => api("/admin/flows", { method: "POST", body: JSON.stringify({ name: nome }) }),
    onSuccess: () => { setNome(""); invalidar(); },
  });
  const acao = useMutation({
    mutationFn: ({ id, acao }: { id: string; acao: string }) =>
      acao === "delete"
        ? api(`/admin/flows/${id}`, { method: "DELETE" })
        : api(`/admin/flows/${id}/${acao}`, { method: "POST" }),
    onSuccess: invalidar,
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Fluxos de conversa</h1>

      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); if (nome.trim()) criar.mutate(); }}
      >
        <input
          className="border border-slate-300 rounded px-3 py-2 flex-1 bg-white"
          placeholder="Nome do novo fluxo" value={nome} onChange={(e) => setNome(e.target.value)}
        />
        <button className="bg-emerald-700 text-white px-4 rounded hover:bg-emerald-800">Criar</button>
      </form>

      <div className="bg-white rounded-xl shadow divide-y divide-slate-100">
        {flows?.map((f) => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1">
              <Link to="/flows/$flowId" params={{ flowId: f.id }} className="font-medium text-emerald-800 hover:underline">
                {f.name}
              </Link>
              {f.active && <span className="ml-2 text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">ativo</span>}
            </div>
            <button
              className="text-sm border border-slate-300 px-3 py-1 rounded hover:bg-slate-50"
              onClick={() => acao.mutate({ id: f.id, acao: f.active ? "deactivate" : "activate" })}
            >
              {f.active ? "Desativar" : "Ativar"}
            </button>
            <button
              className="text-sm text-red-600 border border-red-200 px-3 py-1 rounded hover:bg-red-50"
              onClick={() => { if (confirm(`Excluir o fluxo "${f.name}"?`)) acao.mutate({ id: f.id, acao: "delete" }); }}
            >
              Excluir
            </button>
          </div>
        ))}
        {flows?.length === 0 && <p className="px-4 py-6 text-slate-500">Nenhum fluxo ainda. Sem fluxo ativo, o atendimento usa o grafo padrão.</p>}
      </div>
    </div>
  );
}
