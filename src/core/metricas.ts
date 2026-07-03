// Métricas leves do cache de reescrita — valida se a economia projetada
// (variações geradas 1× e reusadas) acontece de verdade em produção.
// Sem dependência externa: contadores em memória + log estruturado periódico
// (CloudWatch Logs Insights agrega por "[metricas]").

export type EventoReescrita = "hit" | "miss" | "falha";

const contadores: Record<EventoReescrita, number> = { hit: 0, miss: 0, falha: 0 };
const LOG_A_CADA = 50; // eventos entre logs de resumo

export function medirReescrita(evento: EventoReescrita): void {
  contadores[evento]++;
  const total = contadores.hit + contadores.miss;
  if (total > 0 && total % LOG_A_CADA === 0) {
    const pct = ((contadores.hit / total) * 100).toFixed(1);
    console.log(
      `[metricas] reescrita: total=${total} hit=${contadores.hit} (${pct}%) miss=${contadores.miss} falha=${contadores.falha}`
    );
  }
}

// snapshot p/ testes e eventual endpoint de debug
export function snapshotReescrita(): Record<EventoReescrita, number> {
  return { ...contadores };
}
