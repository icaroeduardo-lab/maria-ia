import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../store";

interface Assistido {
  id: string;
  cpf: string;
  nome: string;
  dataNascimento?: string | null;
  nomeMae?: string | null;
  situacao?: string | null;
  municipio?: string | null;
  uf?: string | null;
  telefone?: string | null;
  email?: string | null;
  cep?: string | null;
  bairro?: string | null;
  logradouro?: string | null;
  numero?: string | null;
}

type Lista = { total: number; page: number; itens: Assistido[] };

const CAMPOS: { chave: keyof Assistido; label: string }[] = [
  { chave: "cpf", label: "CPF" },
  { chave: "nome", label: "Nome completo" },
  { chave: "dataNascimento", label: "Data de nascimento" },
  { chave: "nomeMae", label: "Nome da mãe" },
  { chave: "municipio", label: "Município" },
  { chave: "uf", label: "UF" },
  { chave: "telefone", label: "Telefone" },
  { chave: "email", label: "E-mail" },
  { chave: "cep", label: "CEP" },
  { chave: "bairro", label: "Bairro" },
  { chave: "logradouro", label: "Logradouro" },
  { chave: "numero", label: "Número" },
];

const inputCls = "mt-1 w-full border border-slate-300 rounded px-2 py-1.5 text-sm";

export function Assistidos() {
  const qc = useQueryClient();
  const { usuario } = useAuth();
  const isAdmin = usuario?.role === "admin";

  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");
  const [editando, setEditando] = useState<Assistido | null>(null);
  const [criando, setCriando] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["assistidos", buscaAtiva],
    queryFn: () => api<Lista>(`/admin/assistidos?busca=${encodeURIComponent(buscaAtiva)}`),
  });

  const invalidar = () => qc.invalidateQueries({ queryKey: ["assistidos"] });

  const salvar = useMutation({
    mutationFn: (a: Partial<Assistido>) =>
      a.id
        ? api(`/admin/assistidos/${a.id}`, { method: "PUT", body: JSON.stringify(a) })
        : api(`/admin/assistidos`, { method: "POST", body: JSON.stringify(a) }),
    onSuccess: () => { setEditando(null); setCriando(false); invalidar(); },
  });

  const excluir = useMutation({
    mutationFn: (id: string) => api(`/admin/assistidos/${id}`, { method: "DELETE" }),
    onSuccess: invalidar,
  });

  const aberto = criando ? ({} as Assistido) : editando;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-bold text-slate-800">Assistidos</h1>
        {isAdmin && (
          <button
            className="ml-auto bg-emerald-700 text-white text-sm rounded-lg px-3 py-1.5 hover:bg-emerald-800"
            onClick={() => { setCriando(true); setEditando(null); }}
          >
            + Novo assistido
          </button>
        )}
      </div>

      <form
        className="flex gap-2 mb-4"
        onSubmit={(e) => { e.preventDefault(); setBuscaAtiva(busca.trim()); }}
      >
        <input
          className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
          placeholder="Buscar por nome ou CPF..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <button className="bg-slate-200 rounded-lg px-4 text-sm hover:bg-slate-300">Buscar</button>
      </form>

      <div className="bg-white rounded-xl shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">CPF</th>
              <th className="px-4 py-2 font-medium">Nome</th>
              <th className="px-4 py-2 font-medium">Município</th>
              <th className="px-4 py-2 font-medium">Telefone</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">Carregando…</td></tr>
            )}
            {data?.itens.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">Nenhum assistido.</td></tr>
            )}
            {data?.itens.map((a) => (
              <tr key={a.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-mono">{a.cpf}</td>
                <td className="px-4 py-2">{a.nome}</td>
                <td className="px-4 py-2">{a.municipio ? `${a.municipio}${a.uf ? "/" + a.uf : ""}` : "—"}</td>
                <td className="px-4 py-2">{a.telefone || "—"}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <button
                    className="text-emerald-700 hover:underline mr-3"
                    onClick={() => { setEditando(a); setCriando(false); }}
                  >
                    {isAdmin ? "Editar" : "Ver"}
                  </button>
                  {isAdmin && (
                    <button
                      className="text-red-600 hover:underline"
                      onClick={() => { if (confirm(`Excluir ${a.nome}?`)) excluir.mutate(a.id); }}
                    >
                      Excluir
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && <p className="text-xs text-slate-400 mt-2">{data.total} assistido(s)</p>}

      {aberto && (
        <EditorAssistido
          assistido={aberto}
          novo={criando}
          somenteLeitura={!isAdmin}
          salvando={salvar.isPending}
          erro={salvar.error ? String(salvar.error) : null}
          onCancelar={() => { setEditando(null); setCriando(false); salvar.reset(); }}
          onSalvar={(dados) => salvar.mutate(dados)}
        />
      )}
    </div>
  );
}

function EditorAssistido({
  assistido, novo, somenteLeitura, salvando, erro, onCancelar, onSalvar,
}: {
  assistido: Assistido;
  novo: boolean;
  somenteLeitura: boolean;
  salvando: boolean;
  erro: string | null;
  onCancelar: () => void;
  onSalvar: (a: Partial<Assistido>) => void;
}) {
  // busca o registro COMPLETO (a lista vem mascarada; admin recebe full + auditado)
  const { data: completo } = useQuery({
    queryKey: ["assistido", assistido.id],
    queryFn: () => api<Assistido>(`/admin/assistidos/${assistido.id}`),
    enabled: !novo && !!assistido.id,
  });
  const fonte = completo ?? assistido;

  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => {
    const f: Record<string, string> = {};
    for (const { chave } of CAMPOS) f[chave] = String((fonte as Record<string, unknown>)[chave] ?? "");
    setForm(f);
  }, [fonte]);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={onCancelar}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4 text-slate-800">
          {novo ? "Novo assistido" : somenteLeitura ? "Detalhes" : "Editar assistido"}
        </h2>

        <div className="grid grid-cols-2 gap-3">
          {CAMPOS.map(({ chave, label }) => {
            const editavelCpf = chave === "cpf" && !novo; // CPF não muda após criar
            return (
              <label key={chave} className={chave === "nome" ? "col-span-2 block" : "block"}>
                <span className="text-xs text-slate-500">{label}</span>
                <input
                  className={inputCls}
                  value={form[chave]}
                  disabled={somenteLeitura || editavelCpf}
                  onChange={(e) => set(chave, e.target.value)}
                />
              </label>
            );
          })}
        </div>

        {erro && <p className="text-sm text-red-600 mt-3">{erro}</p>}

        <div className="flex gap-2 justify-end mt-5">
          <button className="px-4 py-2 text-sm rounded-lg border hover:bg-slate-50" onClick={onCancelar}>
            {somenteLeitura ? "Fechar" : "Cancelar"}
          </button>
          {!somenteLeitura && (
            <button
              className="px-4 py-2 text-sm rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50"
              disabled={salvando}
              onClick={() => onSalvar(novo ? form : { ...form, id: assistido.id })}
            >
              {salvando ? "Salvando…" : "Salvar"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
