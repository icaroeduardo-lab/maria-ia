import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../store";

export function Login() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    setCarregando(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha }),
      });
      if (!res.ok) throw new Error((await res.json()).erro ?? "falha no login");
      const { token, usuario } = await res.json();
      login(token, usuario);
      navigate({ to: "/" });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "erro");
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={entrar} className="bg-white rounded-xl shadow p-8 w-96 space-y-4">
        <h1 className="text-xl font-bold text-emerald-800">Maria Chat — Painel Admin</h1>
        <input
          className="w-full border border-slate-300 rounded px-3 py-2"
          type="email" placeholder="E-mail" value={email}
          onChange={(e) => setEmail(e.target.value)} required
        />
        <input
          className="w-full border border-slate-300 rounded px-3 py-2"
          type="password" placeholder="Senha" value={senha}
          onChange={(e) => setSenha(e.target.value)} required
        />
        {erro && <p className="text-red-600 text-sm">{erro}</p>}
        <button
          className="w-full bg-emerald-700 text-white rounded py-2 hover:bg-emerald-800 disabled:opacity-50"
          disabled={carregando}
        >
          {carregando ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
