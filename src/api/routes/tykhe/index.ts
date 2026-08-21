import type { FastifyInstance } from "fastify";
import { tykheAssistidosRoutes } from "./assistidos.js";

// Rotas DESMEMBRADAS especificamente pra Tykhe (plataforma legada que hoje
// detém o número real de WhatsApp) chamar durante a integração Maria↔Tykhe —
// pasta separada de /admin e das rotas /api/* internas do fluxo, pra não
// misturar contratos com finalidades diferentes. Ver maria-ia (raiz)
// CLAUDE.md pra contexto da estratégia combinada com o usuário.
export async function tykheRoutes(app: FastifyInstance) {
  await app.register(tykheAssistidosRoutes);
}
