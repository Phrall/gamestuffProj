import { ABILITIES } from '../data';
import type { BattleState } from './battle';
import { areaTiles, inRange } from './combat';
import { key, tileAt } from './grid';
import { reachableTiles } from './pathfinding';
import type { AbilityDef, Point, Unit } from './types';

/** What one enemy could do on its next turn (UX slice readability §1–2). */
export interface Reach {
  unitId: string;
  /** Tiles it can stand on after its move (its own tile included). */
  move: Point[];
  /** Tiles it can hit from any of those, area tiles included; water left out. */
  hit: Point[];
  /** Damage abilities it will have ready next turn. */
  abilities: string[];
}

const damaging = (a: AbilityDef | undefined): a is AbilityDef => !!a && (a.type === 'phys' || a.type === 'magic');

/** Ready next turn: cooldowns tick down by one at the start of the unit's turn. */
function readyNextTurn(u: Unit, id: string): boolean {
  const a = ABILITIES[id];
  if (!damaging(a)) return false;
  if ((u.cooldowns[id] ?? 0) > 1) return false;
  return !(a.oncePerBattle && u.usedOnce.includes(id));
}

/** An enemy's reach: Move and Jump as the AI paths, then every ready damage ability from each tile. */
export function unitReach(state: BattleState, u: Unit): Reach {
  const move = reachableTiles(state, u).map((n) => n.pos);
  const abilities = u.abilities.filter((id) => readyNextTurn(u, id));
  const hit = new Map<string, Point>();
  const { width, height } = state.map;
  for (const from of move) {
    for (const id of abilities) {
      const a = ABILITIES[id]!;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const t = { x, y };
        if (!inRange(state, a, from, t)) continue;
        for (const p of a.area ? areaTiles(state, a, from, t) : [t]) {
          if (tileAt(state.map, p)?.kind === 'water') continue; // nobody stands there (UX: no hatch on water)
          hit.set(key(p), p);
        }
      }
    }
  }
  return { unitId: u.id, move, hit: [...hit.values()], abilities };
}

/** Every tile any standing enemy of `team` could hit on its next turn, with each enemy's reach. */
export function dangerZone(state: BattleState, team: Unit['team'] = 'player'): { tiles: Point[]; reaches: Reach[] } {
  const reaches = state.units.filter((u) => u.team !== team && u.status === 'ok').map((u) => unitReach(state, u));
  const all = new Map<string, Point>();
  for (const r of reaches) for (const p of r.hit) all.set(key(p), p);
  return { tiles: [...all.values()], reaches };
}
