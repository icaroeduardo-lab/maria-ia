import { Redis } from "ioredis";
import { env } from "./env.js";

// Cache com degradação graciosa: usa Redis (ElastiCache) quando REDIS_URL está
// setada; senão, ou em qualquer falha, cai para um Map em memória. NUNCA lança —
// o atendimento não pode quebrar por causa do cache (miss = regenera).

const memoria = new Map<string, { valor: unknown; expira: number }>();

let redis: Redis | null = null;
let redisOk = false;
if (env.redisUrl()) {
  redis = new Redis(env.redisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", (e: Error) => {
    if (redisOk) console.warn("[cache] Redis erro, usando memória:", String(e).slice(0, 80));
    redisOk = false;
  });
  redis.on("ready", () => { redisOk = true; console.log("[cache] Redis conectado"); });
  redis.connect().catch(() => { /* fica em memória */ });
}

function getMem<T>(chave: string): T | null {
  const e = memoria.get(chave);
  if (!e) return null;
  if (e.expira < Date.now()) { memoria.delete(chave); return null; }
  return e.valor as T;
}
function setMem(chave: string, valor: unknown, ttlSeg: number) {
  memoria.set(chave, { valor, expira: Date.now() + ttlSeg * 1000 });
  if (memoria.size > 5000) memoria.delete(memoria.keys().next().value!); // bound simples
}

// incrementa um contador com janela deslizante fixa (reseta ao expirar).
// TTL só é (re)armado no primeiro incremento da janela — igual ao Redis INCR+EXPIRE.
function incrMem(chave: string, ttlSeg: number): number {
  const agora = Date.now();
  const e = memoria.get(chave);
  if (!e || e.expira < agora) {
    memoria.set(chave, { valor: 1, expira: agora + ttlSeg * 1000 });
    return 1;
  }
  const novo = (e.valor as number) + 1;
  e.valor = novo;
  return novo;
}

export async function cacheGet<T>(chave: string): Promise<T | null> {
  if (redis && redisOk) {
    try {
      const v = await redis.get(chave);
      if (v != null) return JSON.parse(v) as T;
    } catch { /* cai pra memória */ }
  }
  return getMem<T>(chave);
}

export async function cacheSet(chave: string, valor: unknown, ttlSeg: number): Promise<void> {
  setMem(chave, valor, ttlSeg); // sempre popula a memória (L1)
  if (redis && redisOk) {
    try { await redis.set(chave, JSON.stringify(valor), "EX", ttlSeg); } catch { /* ignora */ }
  }
}

// contador atômico com janela deslizante fixa (rate limiting — card #20260122).
// Retorna a contagem APÓS o incremento; TTL só é armado no 1º incremento da janela.
export async function cacheIncr(chave: string, ttlSeg: number): Promise<number> {
  if (redis && redisOk) {
    try {
      const n = await redis.incr(chave);
      if (n === 1) await redis.expire(chave, ttlSeg);
      return n;
    } catch { /* cai pra memória */ }
  }
  return incrMem(chave, ttlSeg);
}
