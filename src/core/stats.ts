import { ABILITIES, RULES } from '../data';
import type { BattleState } from './battle';
import type { Stats, Team, Unit } from './types';

export interface MoraleTier { name: string; max: number; hit: number; move: number; dmg: number }

export function moraleTier(value: number): MoraleTier {
  const tiers = RULES.morale.tiers as MoraleTier[];
  return tiers.find((t) => value <= t.max) ?? tiers[tiers.length - 1]!;
}

export function teamMorale(state: BattleState, team: Team): MoraleTier {
  return moraleTier(state.morale[team]);
}

/** Base stats plus active modifiers, passives and morale (§7). */
export function effectiveStats(_state: BattleState, u: Unit): Stats & { allFront: boolean; freeClimb: boolean } {
  const s = { ...u.base, allFront: false, freeClimb: false };
  for (const m of u.modifiers) {
    s.def += m.def ?? 0;
    s.res += m.res ?? 0;
    s.move += m.move ?? 0;
    if (m.allFront) s.allFront = true;
  }
  for (const id of u.abilities) {
    const a = ABILITIES[id];
    if (a?.type === 'passive') {
      s.jump += a.jump ?? 0;
      if (a.freeClimb) s.freeClimb = true;
    }
  }
  s.move += u.moraleMove;
  s.move = Math.max(0, s.move);
  return s;
}
