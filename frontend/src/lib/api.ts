import { useAuth } from "../store";

const BASE = import.meta.env.VITE_API_URL ?? "";

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuth.getState().token;
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      // Content-Type só quando há body (DELETE sem body + json => 400 no Fastify)
      ...(options.body != null && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });
  if (res.status === 401) {
    useAuth.getState().logout();
    throw new Error("sessão expirada");
  }
  if (!res.ok) {
    const corpo = await res.json().catch(() => ({}));
    throw new Error((corpo as { erro?: string }).erro ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
