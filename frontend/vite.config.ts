import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": backend,
      "/auth": backend,
      "/admin": backend,
      "/webhook": backend,
    },
  },
});
