import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../store";

interface ConfigResp {
  estiloPrompt: string;
  conversacional: boolean;
  padrao: string;
}

export function Configuracoes() {
  const { usuario } = useAuth();
  const isAdmin = usuario?.role === "admin";
  const [texto, setTexto] = useState("");
  const [conversacional, setConversacional] = useState(true);
  const [salvo, setSalvo] = useState(false);

  const { data } = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResp>("/admin/config"),
  });

  useEffect(() => {
    if (data) { setTexto(data.estiloPrompt || ""); setConversacional(data.conversacional); }
  }, [data]);

  const salvar = useMutation({
    mutationFn: () => api("/admin/config", { method: "PUT", body: JSON.stringify({ estiloPrompt: texto, conversacional }) }),
    onSuccess: () => { setSalvo(true); setTimeout(() => setSalvo(false), 2500); },
  });

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-xl font-bold text-slate-800 mb-1">Estilo de linguagem da IA</h1>
      <p className="text-sm text-slate-500 mb-4">
        Regras aplicadas a <strong>toda resposta gerada pela IA</strong> (nós de IA Livre).
        Use para garantir linguagem simples e o tom da Defensoria. As regras de estilo ficam aqui
        (sempre aplicadas) — o RAG continua sendo usado só para o conteúdo dos serviços.
      </p>

      <label className="flex items-center gap-2 mb-4 text-sm">
        <input type="checkbox" checked={conversacional} disabled={!isAdmin} onChange={(e) => setConversacional(e.target.checked)} />
        <span><strong>Perguntas conversacionais</strong> — a IA reescreve cada pergunta de forma acolhedora (texto fixo nos nós marcados como "texto fixo")</span>
      </label>

      <textarea
        className="w-full border border-slate-300 rounded-lg p-3 text-sm font-mono min-h-[340px] disabled:bg-slate-50"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        disabled={!isAdmin}
        placeholder={data?.padrao}
      />

      <div className="flex items-center gap-3 mt-3">
        {isAdmin && (
          <button
            className="bg-emerald-700 text-white rounded-lg px-4 py-2 text-sm hover:bg-emerald-800 disabled:opacity-50"
            onClick={() => salvar.mutate()}
            disabled={salvar.isPending}
          >
            {salvar.isPending ? "Salvando…" : "Salvar"}
          </button>
        )}
        {isAdmin && (
          <button
            className="border rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
            onClick={() => data?.padrao && setTexto(data.padrao)}
          >
            Usar padrão
          </button>
        )}
        {salvo && <span className="text-sm text-emerald-700">Salvo ✓</span>}
        {!texto.trim() && <span className="text-xs text-slate-400">Vazio = usa o estilo padrão do sistema</span>}
      </div>
    </div>
  );
}
