import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  type Node, type Edge, type Connection, type NodeProps, Handle, Position,
} from "@xyflow/react";
import { api } from "../lib/api";

// ── Tipos de nó da paleta (espelho de src/engine/builder.ts no backend) ──────

const TIPOS = [
  { tipo: "mensagem", label: "Mensagem", cor: "#0ea5e9" },
  { tipo: "pergunta", label: "Pergunta", cor: "#047857" },
  { tipo: "condicao", label: "Condição", cor: "#d97706" },
  { tipo: "ia", label: "IA Livre", cor: "#7c3aed" },
  { tipo: "classificar", label: "Classificar (IA)", cor: "#9333ea" },
  { tipo: "api", label: "Chamada API", cor: "#475569" },
  { tipo: "subgrafo", label: "Subgrafo (código)", cor: "#0891b2" },
  { tipo: "subfluxo", label: "Subfluxo (tema)", cor: "#0d9488" },
  { tipo: "atribuir", label: "Atribuir campo", cor: "#64748b" },
  { tipo: "encerrar", label: "Encerrar", cor: "#dc2626" },
] as const;

type TipoNo = (typeof TIPOS)[number]["tipo"];
type DataNo = Record<string, unknown> & { tipo: TipoNo };

const corDe = (tipo: string) => TIPOS.find((t) => t.tipo === tipo)?.cor ?? "#64748b";
const labelDe = (tipo: string) => TIPOS.find((t) => t.tipo === tipo)?.label ?? tipo;

function NoCustom({ data, selected }: NodeProps) {
  const d = data as DataNo;
  const resumo = String(d.titulo ?? d.texto ?? d.prompt ?? d.campo ?? d.servico ?? d.chave ?? "");
  return (
    <div
      className="rounded-lg bg-white shadow border-2 px-3 py-2 w-52 text-xs"
      style={{ borderColor: selected ? "#0f172a" : corDe(d.tipo) }}
    >
      <Handle type="target" position={Position.Top} />
      <p className="font-bold" style={{ color: corDe(d.tipo) }}>{labelDe(d.tipo)}</p>
      {resumo && <p className="text-slate-600 truncate">{resumo}</p>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { custom: NoCustom };

// ── Painel lateral de edição ─────────────────────────────────────────────────

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "mt-1 w-full border border-slate-300 rounded px-2 py-1.5 bg-white";

// editor do nó subfluxo: escolhe qual fluxo-tema embutir + link p/ editá-lo
function EditorSubfluxo({ d, set }: { d: DataNo; set: (k: string, v: unknown) => void }) {
  const { flowId } = useParams({ from: "/protected/flows/$flowId" });
  const { data: flows } = useQuery({
    queryKey: ["flows"],
    queryFn: () => api<{ id: string; name: string }[]>("/admin/flows"),
  });
  const opcoes = (flows ?? []).filter((f) => f.id !== flowId);
  const ref = String(d.refFlowId ?? "");
  return (
    <>
      <Campo label="Título (identificação)">
        <input className={inputCls} value={String(d.titulo ?? "")} onChange={(e) => set("titulo", e.target.value)} />
      </Campo>
      <Campo label="Fluxo-tema embutido">
        <select className={inputCls} value={ref} onChange={(e) => set("refFlowId", e.target.value)}>
          <option value="">— selecione —</option>
          {opcoes.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </Campo>
      {ref && (
        <Link to="/flows/$flowId" params={{ flowId: ref }} className="text-sm text-emerald-700 hover:underline">
          ✎ Editar este fluxo-tema
        </Link>
      )}
      <p className="text-xs text-slate-500">
        As perguntas do tema vivem no fluxo selecionado. Edite-o como qualquer fluxo;
        ele é embutido aqui em tempo de execução.
      </p>
    </>
  );
}

function EditorNo({ no, onChange, onRemove }: {
  no: Node; onChange: (data: Record<string, unknown>) => void; onRemove: () => void;
}) {
  const d = no.data as DataNo;
  const set = (k: string, v: unknown) => onChange({ ...d, [k]: v });
  const texto = (k: string, label: string, area = false) => (
    <Campo label={label}>
      {area
        ? <textarea className={inputCls} rows={3} value={String(d[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
        : <input className={inputCls} value={String(d[k] ?? "")} onChange={(e) => set(k, e.target.value)} />}
    </Campo>
  );

  return (
    <div className="space-y-3">
      <p className="font-bold" style={{ color: corDe(d.tipo) }}>{labelDe(d.tipo)}</p>

      {d.tipo === "mensagem" && (
        <>
          {texto("texto", "Texto (use {{chave}} para dados coletados)", true)}
          {texto("imagem", "URL da imagem (opcional)")}
        </>
      )}

      {d.tipo === "pergunta" && (
        <>
          {texto("texto", "Pergunta", true)}
          {texto("chave", "Chave (campo onde salva a resposta)")}
          <Campo label="Tipo de resposta">
            <select className={inputCls} value={String(d.tipoPergunta ?? "texto")} onChange={(e) => set("tipoPergunta", e.target.value)}>
              {["texto", "sim_nao", "opcoes", "cpf", "telefone", "cep", "data"].map((t) => <option key={t}>{t}</option>)}
            </select>
          </Campo>
          {d.tipoPergunta === "opcoes" && (
            <Campo label="Opções (uma por linha)">
              <textarea
                className={inputCls} rows={4}
                value={((d.opcoes as string[]) ?? []).join("\n")}
                onChange={(e) => set("opcoes", e.target.value.split("\n").filter(Boolean))}
              />
            </Campo>
          )}
        </>
      )}

      {d.tipo === "condicao" && (
        <>
          {texto("titulo", "Título (identificação)")}
          {texto("campo", "Campo a comparar")}
          <p className="text-xs text-slate-500">
            Suporta notação de ponto para JSON: <code>resultado_cpf.encontrado</code><br />
            O rótulo de cada seta é o valor esperado (<code>true</code>, <code>false</code>, texto…). <code>*</code> = padrão.
          </p>
        </>
      )}

      {d.tipo === "ia" && (
        <>
          {texto("prompt", "Prompt do sistema", true)}
          <Campo label="Usar base de conhecimento (RAG)">
            <input type="checkbox" className="ml-2" checked={Boolean(d.usarRag)} onChange={(e) => set("usarRag", e.target.checked)} />
          </Campo>
        </>
      )}

      {d.tipo === "classificar" && (
        <>
          {texto("titulo", "Título (identificação)")}
          {texto("chave", "Campo onde grava a categoria")}
          <Campo label="Categorias (uma por linha)">
            <textarea
              className={inputCls} rows={5}
              value={((d.opcoes as string[]) ?? []).join("\n")}
              onChange={(e) => set("opcoes", e.target.value.split("\n").filter(Boolean))}
            />
          </Campo>
          {texto("prompt", "Instrução extra ao classificador (opcional)", true)}
          <p className="text-xs text-slate-500">
            A IA lê o relato do usuário e escolhe UMA categoria. Cada seta saindo da
            condição seguinte usa o nome da categoria como rótulo.
          </p>
        </>
      )}

      {d.tipo === "api" && (
        <>
          {texto("titulo", "Título (identificação)")}
          {texto("url", "URL")}
          <Campo label="Método">
            <select className={inputCls} value={String(d.metodo ?? "POST")} onChange={(e) => set("metodo", e.target.value)}>
              <option>POST</option><option>GET</option>
            </select>
          </Campo>
          {texto("chave", "Salvar resposta no campo")}
        </>
      )}

      {d.tipo === "subgrafo" && (
        <Campo label="Serviço (faz as perguntas do serviço)">
          <select className={inputCls} value={String(d.servico ?? "outros")} onChange={(e) => set("servico", e.target.value)}>
            {["familia_pensao", "trabalhista", "inss_federal", "outros"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Campo>
      )}

      {d.tipo === "subfluxo" && <EditorSubfluxo d={d} set={set} />}

      {d.tipo === "atribuir" && <>{texto("chave", "Campo")}{texto("valor", "Valor")}</>}

      {d.tipo === "encerrar" && <p className="text-xs text-slate-500">Envia os dados coletados para a DPERJ e mostra o protocolo.</p>}

      <button className="text-sm text-red-600 border border-red-200 rounded px-3 py-1 hover:bg-red-50" onClick={onRemove}>
        Remover nó
      </button>
    </div>
  );
}

// ── Página ───────────────────────────────────────────────────────────────────

interface FlowAPI {
  id: string; name: string; active: boolean;
  nodes: { id: string; type: TipoNo; position?: { x: number; y: number }; data: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; label?: string }[];
}

export function Builder() {
  const { flowId } = useParams({ from: "/protected/flows/$flowId" });
  const qc = useQueryClient();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [edgeSelecionada, setEdgeSelecionada] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(true);

  // histórico para Ctrl+Z (refs p/ acesso estável no listener de teclado)
  const historicoRef = useRef<{ nodes: Node[]; edges: Edge[] }[]>([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const selecionadoRef = useRef(selecionado);
  const edgeSelecionadaRef = useRef(edgeSelecionada);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { selecionadoRef.current = selecionado; }, [selecionado]);
  useEffect(() => { edgeSelecionadaRef.current = edgeSelecionada; }, [edgeSelecionada]);

  const salvarHistorico = useCallback(() => {
    historicoRef.current = [
      ...historicoRef.current.slice(-30),
      { nodes: nodesRef.current, edges: edgesRef.current },
    ];
  }, []);

  // teclado: Delete deleta selecionado; Ctrl+Z desfaz
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selecionadoRef.current;
        const edgeSel = edgeSelecionadaRef.current;
        if (sel) {
          salvarHistorico();
          setNodes((ns) => ns.filter((n) => n.id !== sel));
          setEdges((es) => es.filter((x) => x.source !== sel && x.target !== sel));
          setSelecionado(null);
          setSalvo(false);
        } else if (edgeSel) {
          salvarHistorico();
          setEdges((es) => es.filter((x) => x.id !== edgeSel));
          setEdgeSelecionada(null);
          setSalvo(false);
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        const h = historicoRef.current;
        if (!h.length) return;
        const anterior = h[h.length - 1];
        historicoRef.current = h.slice(0, -1);
        setNodes(anterior.nodes);
        setEdges(anterior.edges);
        setSelecionado(null);
        setEdgeSelecionada(null);
        setSalvo(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [salvarHistorico, setNodes, setEdges]);

  // salva snapshot no início de cada drag para Ctrl+Z restaurar posição
  const onNodeDragStart = useCallback(() => salvarHistorico(), [salvarHistorico]);

  // ref para salvar histórico apenas na primeira edição de cada seleção
  const primeiraEdicaoRef = useRef(true);
  useEffect(() => { primeiraEdicaoRef.current = true; }, [selecionado]);

  const { data: flow } = useQuery({
    queryKey: ["flow", flowId],
    queryFn: () => api<FlowAPI>(`/admin/flows/${flowId}`),
    // não refetcha no foco/reconexão: refetch sobrescreveria edições não salvas
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });

  // carrega o flow no canvas SÓ uma vez por flowId (refetch/cache não clobbera edição)
  const carregadoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!flow || carregadoRef.current === flowId) return;
    carregadoRef.current = flowId;
    setNodes(
      flow.nodes.map((n, i) => ({
        id: n.id,
        type: "custom",
        position: n.position ?? { x: 80 + (i % 4) * 260, y: 60 + Math.floor(i / 4) * 140 },
        data: { ...n.data, tipo: n.type },
      }))
    );
    setEdges(flow.edges.map((e) => ({ ...e, label: e.label })));
  }, [flow, flowId, setNodes, setEdges]);

  const salvar = useMutation({
    mutationFn: () =>
      api<FlowAPI>(`/admin/flows/${flowId}`, {
        method: "PUT",
        body: JSON.stringify({
          nodes: nodes.map((n) => {
            const { tipo, ...data } = n.data as DataNo;
            return { id: n.id, type: tipo, position: n.position, data };
          }),
          edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ?? undefined })),
        }),
      }),
    // atualiza o cache com a resposta (não refetcha → não sobrescreve o canvas)
    onSuccess: (saved) => {
      setSalvo(true);
      qc.setQueryData(["flow", flowId], saved);
      qc.invalidateQueries({ queryKey: ["flows"] });
    },
  });

  const sujar = () => setSalvo(false);

  // auto-save: 1.5s após última alteração
  useEffect(() => {
    if (salvo || !flow) return;
    const t = setTimeout(() => salvar.mutate(), 1500);
    return () => clearTimeout(t);
  }, [salvo, nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  const adicionar = (tipo: TipoNo) => {
    salvarHistorico();
    const id = `${tipo}_${Date.now().toString(36)}`;
    setNodes((ns) => [...ns, {
      id, type: "custom",
      position: { x: 120 + Math.random() * 300, y: 80 + Math.random() * 250 },
      data: { tipo },
    }]);
    setSelecionado(id);
    sujar();
  };

  const onConnect = useCallback(
    (c: Connection) => { salvarHistorico(); setEdges((es) => addEdge(c, es)); sujar(); },
    [setEdges, salvarHistorico]
  );

  const noAtual = nodes.find((n) => n.id === selecionado);
  const edgeAtual = edges.find((e) => e.id === edgeSelecionada);

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 120px)" }}>
      {/* paleta */}
      <aside className="w-44 space-y-2">
        <p className="text-sm font-semibold text-slate-500">Adicionar nó</p>
        {TIPOS.map((t) => (
          <button
            key={t.tipo}
            className="w-full text-left text-sm bg-white rounded-lg shadow px-3 py-2 border-l-4 hover:bg-slate-50"
            style={{ borderLeftColor: t.cor }}
            onClick={() => adicionar(t.tipo)}
          >
            {t.label}
          </button>
        ))}
        <button
          className="w-full bg-emerald-700 text-white rounded-lg py-2 hover:bg-emerald-800 disabled:opacity-50"
          disabled={salvo || salvar.isPending}
          onClick={() => salvar.mutate()}
          title="Salvar agora (auto-save em 1.5s)"
        >
          {salvar.isPending ? "Salvando…" : salvo ? "Salvo ✓" : "Salvar agora"}
        </button>
        {salvar.isError && (
          <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1">
            Erro ao salvar: {String((salvar.error as Error)?.message ?? salvar.error)}.
            {/requer perfil admin/i.test(String(salvar.error)) && " Saia e entre novamente no painel."}
          </p>
        )}
        <p className="text-xs text-slate-400">{flow?.name}{flow?.active ? " (ativo)" : ""}</p>
      </aside>

      {/* canvas */}
      <div className="flex-1 bg-white rounded-xl shadow overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={(c) => {
            onNodesChange(c);
            // só marca sujo em mudanças reais (não dimensão/seleção do ReactFlow)
            if (c.some((m) => m.type === "position" || m.type === "remove" || m.type === "add")) sujar();
          }}
          onEdgesChange={(c) => {
            onEdgesChange(c);
            if (c.some((m) => m.type === "remove" || m.type === "add")) sujar();
          }}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeClick={(_, n) => { setSelecionado(n.id); setEdgeSelecionada(null); }}
          onEdgeClick={(_, e) => { setEdgeSelecionada(e.id); setSelecionado(null); }}
          onPaneClick={() => { setSelecionado(null); setEdgeSelecionada(null); }}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>

      {/* painel de edição */}
      <aside className="w-72 bg-white rounded-xl shadow p-4 overflow-y-auto">
        {noAtual && (
          <EditorNo
            no={noAtual}
            onChange={(data) => {
              if (primeiraEdicaoRef.current) {
                salvarHistorico();
                primeiraEdicaoRef.current = false;
              }
              setNodes((ns) => ns.map((n) => (n.id === noAtual.id ? { ...n, data } : n)));
              sujar();
            }}
            onRemove={() => {
              setNodes((ns) => ns.filter((n) => n.id !== noAtual.id));
              setEdges((es) => es.filter((e) => e.source !== noAtual.id && e.target !== noAtual.id));
              setSelecionado(null);
              sujar();
            }}
          />
        )}
        {edgeAtual && (
          <div className="space-y-3">
            <p className="font-bold text-amber-600">Seta</p>
            <Campo label='Rótulo (valor da condição; "*" = padrão)'>
              <input
                className={inputCls}
                value={String(edgeAtual.label ?? "")}
                onChange={(e) => {
                  setEdges((es) => es.map((x) => (x.id === edgeAtual.id ? { ...x, label: e.target.value } : x)));
                  sujar();
                }}
              />
            </Campo>
            <button
              className="text-sm text-red-600 border border-red-200 rounded px-3 py-1 hover:bg-red-50"
              onClick={() => { setEdges((es) => es.filter((x) => x.id !== edgeAtual.id)); setEdgeSelecionada(null); sujar(); }}
            >
              Remover seta
            </button>
          </div>
        )}
        {!noAtual && !edgeAtual && (
          <p className="text-sm text-slate-400">Clique em um nó ou seta para editar. Arraste da borda inferior de um nó até outro para conectar.</p>
        )}
      </aside>
    </div>
  );
}
