import type { FastifyInstance } from "fastify";

// APIs fictícias para testes de fluxo no builder.
// Trocar pelas URLs reais no .env ou substituir as chamadas no fluxo.

export async function mockRoutes(app: FastifyInstance) {
  // POST /mock/verificar-cpf
  // Body: { cpf: "000.000.000-00" }
  // Resposta: { valido, situacao, nome }
  app.post("/mock/verificar-cpf", async (req, reply) => {
    const { cpf } = (req.body ?? {}) as { cpf?: string };
    if (!cpf) return reply.code(400).send({ erro: "cpf obrigatório" });

    const apenasDigitos = cpf.replace(/\D/g, "");
    if (apenasDigitos.length !== 11) {
      console.log(`[mock] verificar-cpf: formato inválido — "${cpf}"`);
      return { encontrado: false, situacao: "formato_invalido", dados: null };
    }

    const CADASTRADOS: Record<string, object> = {
      "00000000000": {
        nome: "João da Silva Santos",
        dataNascimento: "1985-03-22",
        nomeMae: "Maria Aparecida da Silva",
        situacao: "regular",
        municipio: "Rio de Janeiro",
        uf: "RJ",
      },
    };

    const encontrado = apenasDigitos in CADASTRADOS;
    const resposta = {
      encontrado,
      situacao: encontrado ? "regular" : "nao_cadastrado",
      dados: encontrado ? CADASTRADOS[apenasDigitos] : null,
    };
    console.log(`[mock] verificar-cpf: CPF ${cpf} → ${JSON.stringify(resposta)}`);
    return resposta;
  });

  // POST /mock/cadastrar-usuario
  // Body: { nome, cpf, dataNascimento, telefone, email?, cep, cidade, bairro, rua, numero }
  // Resposta: { protocolo, mensagem }
  app.post("/mock/cadastrar-usuario", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const obrigatorios = ["nome", "cpf"];
    const faltando = obrigatorios.filter((k) => !body[k]);
    if (faltando.length) {
      return reply.code(400).send({ erro: `campos obrigatórios faltando: ${faltando.join(", ")}` });
    }

    const protocolo = `MOCK-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;
    console.log(`[mock] cadastro recebido — protocolo ${protocolo}:`, body);

    return {
      protocolo,
      mensagem: `Cadastro realizado com sucesso. Protocolo: ${protocolo}`,
    };
  });

  // POST /mock/kyc — reconhecimento facial/identidade (ferramenta ainda não existe)
  // Body: { cpf } | Resposta: { confirmado, score }
  // Simulação: CPF terminado em par confirma; ímpar falha (p/ testar os 2 caminhos)
  app.post("/mock/kyc", async (req) => {
    const { cpf } = (req.body ?? {}) as { cpf?: string };
    const digitos = (cpf ?? "").replace(/\D/g, "");
    const ultimo = Number(digitos.slice(-1) || "0");
    const confirmado = ultimo % 2 === 0;
    const resposta = { confirmado, score: confirmado ? 0.98 : 0.41 };
    console.log(`[mock] kyc: CPF ${cpf} → ${JSON.stringify(resposta)}`);
    return resposta;
  });

  // POST /mock/agendamento — cria agendamento de atendimento
  // Resposta: { agendamento_id, data, unidade }
  app.post("/mock/agendamento", async () => {
    const id = `AG-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;
    const data = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const resposta = { agendamento_id: id, data, unidade: "DPERJ — Núcleo Centro, Av. Rio Branco 147" };
    console.log(`[mock] agendamento criado: ${JSON.stringify(resposta)}`);
    return resposta;
  });

  // POST /mock/processos — lista processos do CPF
  // Body: { cpf } | Resposta: { tem_processo, processos: [{numero, assunto, status}] }
  app.post("/mock/processos", async (req) => {
    const { cpf } = (req.body ?? {}) as { cpf?: string };
    const digitos = (cpf ?? "").replace(/\D/g, "");

    const BASE: Record<string, object[]> = {
      "00000000000": [
        { numero: "0801234-56.2025.8.19.0001", assunto: "Pensão alimentícia", status: "Em andamento" },
        { numero: "0809876-54.2024.8.19.0001", assunto: "Divórcio", status: "Concluído" },
      ],
    };
    const processos = BASE[digitos] ?? [];
    const resposta = { tem_processo: processos.length > 0, processos };
    console.log(`[mock] processos: CPF ${cpf} → ${processos.length} processo(s)`);
    return resposta;
  });
}
