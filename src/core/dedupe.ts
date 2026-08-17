// Dedupe simples de reentrega de webhook, por id, com Set + eviction quando
// cresce demais (evita crescer sem limite ao longo da vida do processo).
// Usado por cada canal (WhatsApp: message.id — a Meta reentrega; Telegram:
// update_id — sequencial) pra descartar retries do provedor sem reprocessar
// a mesma mensagem 2x. Cada canal cria sua PRÓPRIA instância (Sets isolados
// — ids de canais diferentes nunca colidem, mesmo que numericamente iguais).
export function criarDedupe(limite = 1000) {
  const vistos = new Set<string>();
  return function jaProcessado(id: string): boolean {
    if (vistos.has(id)) return true;
    vistos.add(id);
    if (vistos.size > limite) {
      for (const antigo of vistos) {
        vistos.delete(antigo);
        if (vistos.size <= limite / 2) break;
      }
    }
    return false;
  };
}
