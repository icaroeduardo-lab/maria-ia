import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Usuario {
  email: string;
  nome: string;
  role: string;
}

interface AuthState {
  token: string | null;
  usuario: Usuario | null;
  login: (token: string, usuario: Usuario) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      usuario: null,
      login: (token, usuario) => set({ token, usuario }),
      logout: () => set({ token: null, usuario: null }),
    }),
    { name: "mariachat-auth" }
  )
);
