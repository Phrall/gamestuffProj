import { RULES } from '../data';
import type { BattleState } from './battle';
import { heightAt, isPassable, key, neighbors, tileAt } from './grid';
import { effectiveStats } from './stats';
import type { Point, Unit } from './types';

export interface PathNode { pos: Point; cost: number; prev: string | null }
export type PathTree = Map<string, PathNode>;

/**
 * Cost to step from a to b for this unit, or null if the step is not allowed (§3).
 * Entering costs 1 + height climbed (Sure Footing: no climb cost); fords cost 2.
 * Climb up to Jump; drop up to Jump + dropAllowance.
 */
export function stepCost(state: BattleState, unit: Unit, a: Point, b: Point): number | null {
  const to = tileAt(state.map, b);
  if (!isPassable(to)) return null;
  const s = effectiveStats(state, unit);
  const dh = to!.height - heightAt(state.map, a);
  if (dh > s.jump) return null;
  if (-dh > s.jump + RULES.movement.dropAllowance) return null;
  if (to!.kind === 'ford') return RULES.movement.fordCost;
  return 1 + (s.freeClimb ? 0 : Math.max(0, dh));
}

/**
 * Units on the board that occupy a tile (downed units still do; lost units don't).
 * Nothing can end a move on an occupied tile, and it still blocks Shove destinations.
 */
export function occupant(state: BattleState, p: Point): Unit | undefined {
  return state.units.find((u) => u.status !== 'lost' && u.pos.x === p.x && u.pos.y === p.y);
}

/**
 * Dijkstra from the unit's tile. Allies and downed units can be passed through but not
 * stopped on; standing enemies block. `budget` defaults to the unit's Move; pass Infinity for distance fields.
 */
export function pathTree(state: BattleState, unit: Unit, budget = effectiveStats(state, unit).move, from: Point = unit.pos): PathTree {
  const tree: PathTree = new Map();
  tree.set(key(from), { pos: from, cost: 0, prev: null });
  const open: PathNode[] = [{ pos: from, cost: 0, prev: null }];
  while (open.length) {
    open.sort((a, b) => a.cost - b.cost || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    const cur = open.shift()!;
    if (cur.cost > (tree.get(key(cur.pos))?.cost ?? Infinity)) continue;
    for (const n of neighbors(state.map, cur.pos)) {
      const c = stepCost(state, unit, cur.pos, n);
      if (c === null) continue;
      const occ = occupant(state, n);
      // Standing enemies block. Downed units (revive window open) can be passed by anyone (§8).
      if (occ && occ.status === 'ok' && occ.team !== unit.team) continue;
      const cost = cur.cost + c;
      if (cost > budget) continue;
      const k = key(n);
      const prev = tree.get(k);
      if (prev && prev.cost <= cost) continue;
      const node = { pos: n, cost, prev: key(cur.pos) };
      tree.set(k, node);
      open.push(node);
    }
  }
  return tree;
}

/** Tiles the unit can end its move on (its own tile included). */
export function reachableTiles(state: BattleState, unit: Unit): PathNode[] {
  return [...pathTree(state, unit).values()].filter((n) => {
    const occ = occupant(state, n.pos);
    return !occ || occ.id === unit.id;
  });
}

/** Path from the tree root to `to`, root excluded. Empty if unreachable or the root itself. */
export function pathTo(tree: PathTree, to: Point): Point[] {
  const path: Point[] = [];
  let node = tree.get(key(to));
  if (!node) return path;
  while (node && node.prev !== null) {
    path.unshift(node.pos);
    node = tree.get(node.prev);
  }
  return path;
}
