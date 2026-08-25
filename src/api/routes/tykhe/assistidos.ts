import type { FastifyInstance } from "fastify";
import { so_digitos, atualizarCampoAssistido } from "../assistidos.js";

// SEM AUTENTICAÇÃO (protótipo/temporário da integração Maria↔Tykhe) — expõe PII de assistido; não subir pra produção sem token.

// campo aceito num único PATCH da Tykhe — pequeno e explícito de propósito:
// o fluxo da Tykhe pergunta "qual dado quer atualizar" via menu fixo
// (Nome/Telefone/Email/Endereço) e manda só o campo escolhido + valor novo.
const CAMPOS_TYKHE = [
  "nome",
  "telefone",
  "email",
  "cep",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "municipio",
  "uf",
] as const;
type CampoTykhe = (typeof CAMPOS_TYKHE)[number];

function ehCampoValido(campo: unknown): campo is CampoTykhe {
  return typeof campo === "string" && (CAMPOS_TYKHE as readonly string[]).includes(campo);
}

export async function tykheAssistidosRoutes(app: FastifyInstance) {
  // POST /api/tykhe/assistidos/atualizar — { cpf, campo, valor } → { sucesso, dados }
  // Atualiza 1 campo por vez (o menu fixo da Tykhe já restringe a escolha) —
  // reaproveita a mesma lógica de negócio de /api/assistidos/atualizar
  // (atualizarCampoAssistido em ../assistidos.ts: Verde primeiro, fallback
  // local), só muda o shape do corpo de entrada.
  app.post("/api/tykhe/assistidos/atualizar", async (req, reply) => {
    const body = (req.body ?? {}) as { cpf?: string; campo?: string; valor?: string };
    const cpf = so_digitos(body.cpf);
    if (cpf.length !== 11) return reply.code(400).send({ sucesso: false, erro: "cpf inválido" });

    if (!ehCampoValido(body.campo)) {
      return reply
        .code(400)
        .send({ sucesso: false, erro: `campo inválido — use um de: ${CAMPOS_TYKHE.join(", ")}` });
    }

    const valor = typeof body.valor === "string" ? body.valor.trim() : "";
    if (!valor) return reply.code(400).send({ sucesso: false, erro: "valor obrigatório" });

    const resultado = await atualizarCampoAssistido(cpf, { [body.campo]: valor });
    if (!resultado.sucesso) return reply.code(404).send(resultado);
    return resultado;
  });
}
