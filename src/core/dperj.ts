import { prisma } from "./db.js";
import { env } from "./env.js";

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
  const url = env.dperjApiUrl()!;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.dperjApiKey() ?? ""}`,
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
  if (!env.dperjApiUrl()) {
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

interface ItemFilaClaimado {
  id: string;
  payload: unknown;
  tentativas: number;
}

// Reprocessa a fila de envios pendentes (chamado periodicamente pelo server,
// em CADA réplica da API — produção roda api_min=2+). O claim abaixo é uma
// única query atômica (UPDATE...FOR UPDATE SKIP LOCKED...RETURNING): duas
// réplicas rodando ao mesmo tempo nunca pegam o mesmo item (issue #68).
// O POST à DPERJ roda DEPOIS, fora de transação — não pode segurar lock de
// linha durante uma chamada HTTP externa (timeout de até 10s).
export async function processarFila(): Promise<void> {
  if (!env.dperjApiUrl() || !prisma) return;

  const claimados = await prisma.$queryRaw<ItemFilaClaimado[]>`
    UPDATE "DperjFila"
    SET "bloqueadoAte" = now() + interval '2 minutes'
    WHERE id IN (
      SELECT id FROM "DperjFila"
      WHERE "bloqueadoAte" IS NULL OR "bloqueadoAte" < now()
      ORDER BY "criadoEm" ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, payload, tentativas
  `;

  for (const item of claimados) {
    try {
      const protocolo = await postDPERJ(item.payload as unknown as PayloadDPERJ);
      await prisma.dperjFila.delete({ where: { id: item.id } });
      console.log(`[dperj] retry ok — fila ${item.id} → protocolo ${protocolo}`);
    } catch (err) {
      await prisma.dperjFila.update({
        where: { id: item.id },
        data: { tentativas: item.tentativas + 1, ultimoErro: String(err), bloqueadoAte: null },
      });
    }
  }
}
