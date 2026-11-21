import { CLASSES, deriveStats, parseMap, type BattleSetup, type UnitSetup } from '../src/data';
import { createBattle, type BattleState } from '../src/core/battle';
import type { Facing } from '../src/core/types';

export function flatRows(w: number, h: number, fill = '0'): string[] {
  return Array.from({ length: h }, () => Array(w).fill(fill).join(' '));
}

export function unit(id: string, team: 'player' | 'enemy', classId: string, x: number, y: number, facing: Facing = 'N', over: Partial<UnitSetup> = {}): UnitSetup {
  const c = CLASSES[classId]!;
  // Level 3, like the Mill Ford squad (§19).
  return { id, name: id, team, classId, leader: false, stats: deriveStats(classId, 3), abilities: [...c.abilities], pos: { x, y }, facing, ...over };
}

export function battle(rows: string[], units: UnitSetup[], seed = 1): BattleState {
  const setup: BattleSetup = { map: parseMap({ id: 't', name: 't', width: rows[0]!.split(' ').length, height: rows.length, rows }), units };
  return createBattle(setup, seed);
}
