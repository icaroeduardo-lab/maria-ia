import { prisma } from "./db.js";

// Cliente da API interna da DPERJ + fila de retry no Postgres (model DperjFila).
// Sem DPERJ_API_URL configurada roda em modo mock: gera protocolo local e loga o payload.
// Sem DATABASE_URL (dev) a fila fica desativada — só loga a falha (o atendimento segue).

export interface PayloadDPERJ {
  canal: "whatsapp" | "web";
  categoria: string;
  timestamp_inicio: string;
  timestamp_fim: string;
  dados_pessoais: {
    nome?: string;
    cpf?: string;
    data_nascimento?: string;
    telefone?: string;
    email?: string;
  };
  dados_residenciais: {
    cep?: string;
    rua?: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
  };
  dados_caso: Record<string, string>;
}

function gerarProtocoloLocal(): string {
  const ano = new Date().getFullYear();
  const seq = Math.floor(Math.random() * 90000) + 10000;
  return `MARIA-${ano}-${seq}`;
}

async function postDPERJ(payload: PayloadDPERJ): Promise<string> {
  const url = process.env.DPERJ_API_URL!;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DPERJ_API_KEY ?? ""}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DPERJ API HTTP ${res.status}`);
  const body = (await res.json()) as { protocolo?: string; id?: string };
  return body.protocolo ?? body.id ?? gerarProtocoloLocal();
}

// Envia o atendimento. Retorna o protocolo, ou null se a API falhou
// (payload fica na fila para retry posterior — ver processarFila).
export async function enviarParaDPERJ(payload: PayloadDPERJ): Promise<string | null> {
  if (!process.env.DPERJ_API_URL) {
    const protocolo = gerarProtocoloLocal();
    console.log(`[dperj] mock (DPERJ_API_URL não configurada) — protocolo ${protocolo}`);
    console.log(`[dperj] payload:`, JSON.stringify(payload));
    return protocolo;
  }
  try {
    return await postDPERJ(payload);
  } catch (err) {
    console.error("[dperj] envio falhou, salvando na fila:", err);
    if (prisma) {
      await prisma.dperjFila
        .create({ data: { payload: payload as object, ultimoErro: String(err) } })
        .catch((e) => console.error("[dperj] falha ao enfileirar:", e));
    } else {
      console.error("[dperj] sem DATABASE_URL — fila desativada, payload perdido");
    }
    return null;
  }
}

// Reprocessa a fila de envios pendentes (chamado periodicamente pelo server).
export async function processarFila(): Promise<void> {
  if (!process.env.DPERJ_API_URL || !prisma) return;
  const pendentes = await prisma.dperjFila.findMany({ orderBy: { criadoEm: "asc" }, take: 20 });

  for (const item of pendentes) {
    try {
      const protocolo = await postDPERJ(item.payload as unknown as PayloadDPERJ);
      await prisma.dperjFila.delete({ where: { id: item.id } });
      console.log(`[dperj] retry ok — fila ${item.id} → protocolo ${protocolo}`);
    } catch (err) {
      await prisma.dperjFila.update({
        where: { id: item.id },
        data: { tentativas: item.tentativas + 1, ultimoErro: String(err) },
      });
    }
  }
}
