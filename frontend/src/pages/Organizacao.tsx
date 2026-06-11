import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../store";

interface Uso { usadas: number; limite: number; excedido: boolean }
interface OrgInfo {
  id: string; slug: string; name: string; plano: string;
  limiteConversasMes: number; waPhoneNumberId: string | null;
  uso: Uso; planos: Record<string, { limiteConversasMes: number; preco: string }>; stripe: boolean;
}
interface Usuario { id: string; email: string; nome: string; role: string }
interface OrgLista {
  id: string; slug: string; name: string; plano: string;
  uso: Uso; _count: { users: number; flows: number };
}

const inputCls = "w-full border border-slate-300 rounded px-3 py-2 bg-white";

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl shadow p-5 space-y-3">
      <h2 className="font-semibold">{titulo}</h2>
      {children}
    </section>
  );
}

export function Organizacao() {
  const qc = useQueryClient();
  const role = useAuth((s) => s.usuario?.role);
  const ehAdmin = role === "admin" || role === "superadmin";

  const { data: org } = useQuery({ queryKey: ["org"], queryFn: () => api<OrgInfo>("/admin/org") });
  const { data: usuarios } = useQuery({
    queryKey: ["users"],
    queryFn: () => api<Usuario[]>("/admin/users"),
    enabled: ehAdmin,
  });
  const { data: orgs } = useQuery({
    queryKey: ["orgs"],
    queryFn: () => api<OrgLista[]>("/admin/orgs"),
    enabled: role === "superadmin",
  });

  const upgrade = useMutation({
    mutationFn: (plano: string) =>
      api<{ checkoutUrl?: string; aplicadoDireto?: boolean }>("/admin/org/upgrade", {
        method: "POST", body: JSON.stringify({ plano }),
      }),
    onSuccess: (r) => {
      if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else qc.invalidateQueries({ queryKey: ["org"] });
    },
  });

  const [novoUsuario, setNovoUsuario] = useState({ email: "", senha: "", nome: "", role: "viewer" });
  const criarUsuario = useMutation({
    mutationFn: () => api("/admin/users", { method: "POST", body: JSON.stringify(novoUsuario) }),
    onSuccess: () => { setNovoUsuario({ email: "", senha: "", nome: "", role: "viewer" }); qc.invalidateQueries({ queryKey: ["users"] }); },
  });

  const [novaOrg, setNovaOrg] = useState({ name: "", slug: "", plano: "free", adminEmail: "", adminSenha: "" });
  const criarOrg = useMutation({
    mutationFn: () => api("/admin/orgs", { method: "POST", body: JSON.stringify(novaOrg) }),
    onSuccess: () => { setNovaOrg({ name: "", slug: "", plano: "free", adminEmail: "", adminSenha: "" }); qc.invalidateQueries({ queryKey: ["orgs"] }); },
  });

  if (!org) return <p>Carregando…</p>;
  const pct = org.uso.limite > 0 ? Math.min(100, Math.round((org.uso.usadas / org.uso.limite) * 100)) : 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Organização</h1>

      <Secao titulo={`${org.name} (${org.slug})`}>
        <p className="text-sm">
          Plano <span className="font-bold uppercase text-emerald-800">{org.plano}</span>
          {" — "}{org.uso.usadas} conversa(s) este mês
          {org.uso.limite > 0 ? ` de ${org.uso.limite}` : " (ilimitado)"}
        </p>
        {org.uso.limite > 0 && (
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className={`h-full ${pct >= 90 ? "bg-red-500" : "bg-emerald-600"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {org.uso.excedido && <p className="text-sm text-red-600">Limite atingido — novas conversas estão bloqueadas.</p>}
        {ehAdmin && (
          <div className="flex gap-2 pt-2">
            {Object.entries(org.planos).map(([nome, p]) => (
              <button
                key={nome}
                disabled={nome === org.plano || upgrade.isPending}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-emerald-50 disabled:opacity-40 border-slate-300"
                onClick={() => upgrade.mutate(nome)}
              >
                <span className="font-bold uppercase">{nome}</span>
                <span className="block text-xs text-slate-500">
                  {p.limiteConversasMes > 0 ? `${p.limiteConversasMes}/mês` : "ilimitado"} — {p.preco}
                </span>
              </button>
            ))}
          </div>
        )}
        {!org.stripe && ehAdmin && (
          <p className="text-xs text-slate-400">Stripe não configurado — troca de plano aplicada direto (modo dev).</p>
        )}
      </Secao>

      {ehAdmin && (
        <Secao titulo="Usuários">
          <ul className="divide-y divide-slate-100 text-sm">
            {usuarios?.map((u) => (
              <li key={u.id} className="py-2 flex justify-between">
                <span>{u.nome || u.email} <span className="text-slate-400">({u.email})</span></span>
                <span className="text-xs bg-slate-100 px-2 py-0.5 rounded-full self-center">{u.role}</span>
              </li>
            ))}
          </ul>
          <form
            className="grid grid-cols-2 gap-2 pt-2"
            onSubmit={(e) => { e.preventDefault(); criarUsuario.mutate(); }}
          >
            <input className={inputCls} placeholder="E-mail" type="email" required
              value={novoUsuario.email} onChange={(e) => setNovoUsuario({ ...novoUsuario, email: e.target.value })} />
            <input className={inputCls} placeholder="Senha" type="password" required
              value={novoUsuario.senha} onChange={(e) => setNovoUsuario({ ...novoUsuario, senha: e.target.value })} />
            <input className={inputCls} placeholder="Nome"
              value={novoUsuario.nome} onChange={(e) => setNovoUsuario({ ...novoUsuario, nome: e.target.value })} />
            <div className="flex gap-2">
              <select className={inputCls} value={novoUsuario.role}
                onChange={(e) => setNovoUsuario({ ...novoUsuario, role: e.target.value })}>
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
              </select>
              <button className="bg-emerald-700 text-white rounded px-4 hover:bg-emerald-800">Criar</button>
            </div>
          </form>
        </Secao>
      )}

      {role === "superadmin" && (
        <Secao titulo="Organizações (superadmin)">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr><th>Org</th><th>Slug</th><th>Plano</th><th>Uso/mês</th><th>Usuários</th><th>Fluxos</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orgs?.map((o) => (
                <tr key={o.id}>
                  <td className="py-2">{o.name}</td>
                  <td className="font-mono text-xs">{o.slug}</td>
                  <td className="uppercase text-xs">{o.plano}</td>
                  <td>{o.uso.usadas}{o.uso.limite > 0 ? `/${o.uso.limite}` : ""}</td>
                  <td>{o._count.users}</td>
                  <td>{o._count.flows}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <form
            className="grid grid-cols-2 gap-2 pt-3 border-t border-slate-100"
            onSubmit={(e) => { e.preventDefault(); criarOrg.mutate(); }}
          >
            <input className={inputCls} placeholder="Nome da organização" required
              value={novaOrg.name} onChange={(e) => setNovaOrg({ ...novaOrg, name: e.target.value })} />
            <input className={inputCls} placeholder="slug (subdomínio)" required pattern="[a-z0-9-]{2,30}"
              value={novaOrg.slug} onChange={(e) => setNovaOrg({ ...novaOrg, slug: e.target.value })} />
            <input className={inputCls} placeholder="E-mail do admin" type="email" required
              value={novaOrg.adminEmail} onChange={(e) => setNovaOrg({ ...novaOrg, adminEmail: e.target.value })} />
            <input className={inputCls} placeholder="Senha do admin" type="password" required
              value={novaOrg.adminSenha} onChange={(e) => setNovaOrg({ ...novaOrg, adminSenha: e.target.value })} />
            <select className={inputCls} value={novaOrg.plano}
              onChange={(e) => setNovaOrg({ ...novaOrg, plano: e.target.value })}>
              <option value="free">free</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
            </select>
            <button className="bg-emerald-700 text-white rounded px-4 py-2 hover:bg-emerald-800">Criar organização</button>
          </form>
          {criarOrg.error && <p className="text-sm text-red-600">{String(criarOrg.error)}</p>}
        </Secao>
      )}
    </div>
  );
}
