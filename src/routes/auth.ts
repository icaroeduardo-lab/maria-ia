import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";

export interface UsuarioJWT {
  sub: string;
  email: string;
  nome: string;
  role: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: UsuarioJWT;
    user: UsuarioJWT;
  }
}

export async function autenticar(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ erro: "não autenticado" });
  }
}

export async function exigirAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.user.role !== "admin") {
    return reply.code(403).send({ erro: "requer perfil admin" });
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req, reply) => {
    if (!prisma) return reply.code(503).send({ erro: "banco não configurado" });
    const { email, senha } = (req.body ?? {}) as { email?: string; senha?: string };
    if (!email || !senha) return reply.code(400).send({ erro: "email e senha obrigatórios" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !bcrypt.compareSync(senha, user.senha)) {
      return reply.code(401).send({ erro: "credenciais inválidas" });
    }

    const token = app.jwt.sign(
      { sub: user.id, email: user.email, nome: user.nome, role: user.role },
      { expiresIn: "8h" }
    );
    return { token, usuario: { email: user.email, nome: user.nome, role: user.role } };
  });

  app.get("/auth/me", { preHandler: [autenticar] }, async (req) => req.user);
}
