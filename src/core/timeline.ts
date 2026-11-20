import { RULES } from '../data';
import type { Unit } from './types';

/** Who acts first among units at or over the threshold (§2, §13.2): highest CT, then Spd, then data-file order. */
export function compareTurnOrder(a: Unit, b: Unit): number {
  return b.ct - a.ct || b.base.spd - a.base.spd || a.order - b.order;
}

export function ready(units: Unit[]): Unit[] {
  return units.filter((u) => u.status !== 'lost' && u.ct >= RULES.ctThreshold).sort(compareTurnOrder);
}

/** Advance ticks until someone reaches the threshold; returns that unit (not removed from CT). */
export function advance(units: Unit[]): Unit | null {
  const alive = units.filter((u) => u.status !== 'lost');
  if (!alive.length || alive.every((u) => u.base.spd <= 0)) return null;
  for (;;) {
    const r = ready(alive);
    if (r.length) return r[0]!;
    for (const u of alive) u.ct += u.base.spd;
  }
}

export interface TimelineEntry { unitId: string; downed: boolean }

/**
 * Forecast of the next `count` turns (§2): simulates ticks on copies, assuming each
 * unit takes a full turn (CT 0). `activeId` is the unit whose turn it is now, listed first;
 * `activeCtAfter` is its CT after this turn (40 previews a Wait).
 */
export function forecast(units: Unit[], count: number = RULES.timelinePreviewTurns, activeId?: string, activeCtAfter = 0): TimelineEntry[] {
  const sim = units
    .filter((u) => u.status !== 'lost')
    .map((u) => ({ ...u, pos: { ...u.pos }, ct: u.ct, reviveCounter: u.reviveCounter }));
  const out: TimelineEntry[] = [];
  if (activeId) {
    const a = sim.find((u) => u.id === activeId);
    if (a) {
      out.push({ unitId: a.id, downed: a.status === 'downed' });
      a.ct = activeCtAfter;
    }
  }
  while (out.length < count) {
    const next = advance(sim);
    if (!next) break;
    out.push({ unitId: next.id, downed: next.status === 'downed' });
    next.ct = 0;
    if (next.status === 'downed') {
      next.reviveCounter -= 1;
      if (next.reviveCounter <= 0) next.status = 'lost';
    }
  }
  return out;
}
