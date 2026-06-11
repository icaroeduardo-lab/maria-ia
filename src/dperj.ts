import Database from "better-sqlite3";
import { mkdirSync } from "fs";

// Cliente da API interna da DPERJ + fila local de retry.
// Sem DPERJ_API_URL configurada roda em modo mock: gera protocolo local e loga o payload.

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

mkdirSync("./data", { recursive: true });
const db = new Database("./data/fila-envios.db");
db.exec(`CREATE TABLE IF NOT EXISTS fila_envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultimo_erro TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
)`);

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
    db.prepare("INSERT INTO fila_envios (payload, ultimo_erro) VALUES (?, ?)").run(
      JSON.stringify(payload),
      String(err)
    );
    return null;
  }
}

// Reprocessa a fila de envios pendentes (chamado periodicamente pelo server).
export async function processarFila(): Promise<void> {
  if (!process.env.DPERJ_API_URL) return;
  const pendentes = db
    .prepare("SELECT id, payload, tentativas FROM fila_envios ORDER BY id LIMIT 20")
    .all() as { id: number; payload: string; tentativas: number }[];

  for (const item of pendentes) {
    try {
      const protocolo = await postDPERJ(JSON.parse(item.payload));
      db.prepare("DELETE FROM fila_envios WHERE id = ?").run(item.id);
      console.log(`[dperj] retry ok — fila #${item.id} → protocolo ${protocolo}`);
    } catch (err) {
      db.prepare("UPDATE fila_envios SET tentativas = ?, ultimo_erro = ? WHERE id = ?").run(
        item.tentativas + 1,
        String(err),
        item.id
      );
    }
  }
}
