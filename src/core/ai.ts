import { ABILITIES } from '../data';
import type { BattleState } from './battle';
import { abilityReady, isOffensive, previewAction, targetTiles } from './combat';
import { facingToward, heightAt, key, manhattan } from './grid';
import { occupant, pathTo, pathTree, reachableTiles } from './pathfinding';
import type { ActionPreview, Facing, Point, Unit } from './types';

export interface AiPlan {
  unitId: string;
  /** Where to move first; equals the unit's tile if it stays. */
  moveTo: Point;
  action: { abilityId: string; target: Point } | null;
  facing: Facing;
  score: number;
  reason: string;
}

const living = (state: BattleState, team: string) => state.units.filter((u) => u.team === team && u.status === 'ok');

function nearestFoe(state: BattleState, unit: Unit, from: Point): Unit | undefined {
  return living(state, unit.team === 'player' ? 'enemy' : 'player').sort((a, b) => manhattan(from, a.pos) - manhattan(from, b.pos) || a.order - b.order)[0];
}

/**
 * Enemy AI from the spec (§11). Deterministic: every tie breaks by tile scan order
 * and data-file order, so QA can reproduce a battle from its seed.
 */
export function planTurn(state: BattleState, unit: Unit): AiPlan {
  const stay: AiPlan = { unitId: unit.id, moveTo: unit.pos, action: null, facing: unit.facing, score: 0, reason: 'wait' };
  const foes = living(state, unit.team === 'player' ? 'enemy' : 'player');
  if (!foes.length) return stay;

  // Rule 4: hold position until a foe comes within range.
  const hold = unit.ai?.holdUntilWithin;
  if (hold !== undefined && !foes.some((f) => manhattan(f.pos, unit.pos) <= hold)) {
    return { ...stay, facing: facingToward(unit.pos, nearestFoe(state, unit, unit.pos)!.pos, unit.facing), reason: 'holding' };
  }

  const tiles = reachableTiles(state, unit).sort((a, b) => a.cost - b.cost || a.pos.y - b.pos.y || a.pos.x - b.pos.x);

  // Rule 1: healer mends the most hurt ally below the threshold.
  const healId = unit.abilities.find((id) => ABILITIES[id]?.type === 'heal');
  if (unit.ai?.healBelow !== undefined && healId && abilityReady(unit, healId)) {
    const hurt = state.units
      .filter((u) => u.team === unit.team && u.status !== 'lost' && u.hp < u.base.hp * unit.ai!.healBelow!)
      .sort((a, b) => a.hp / a.base.hp - b.hp / b.base.hp || a.order - b.order);
    for (const h of hurt) {
      for (const t of tiles) {
        if (previewAction(state, unit, healId, h.pos, t.pos).victims.length && targetTiles(state, unit, healId, t.pos).some((p) => p.x === h.pos.x && p.y === h.pos.y)) {
          return { unitId: unit.id, moveTo: t.pos, action: { abilityId: healId, target: h.pos }, facing: facingToward(t.pos, h.pos, unit.facing), score: 1, reason: `mend ${h.id}` };
        }
      }
    }
  }

  // Rule 2: best expected damage over (tile, ability, target).
  const best = bestAttack(state, unit, tiles.map((t) => t.pos), (_p, s) => s, (p) => unit.ai?.prefersHeight !== undefined && heightAt(state.map, p) >= unit.ai.prefersHeight);
  if (best) return best;
  return advance(state, unit, tiles.map((t) => t.pos));
}

/** Expected-damage score of a preview (§11 rule 2): hit% × damage, ×2 if it downs, ×1.2 on the lowest-HP foe. */
export function expectedScore(state: BattleState, unit: Unit, p: ActionPreview): number {
  const foes = living(state, unit.team === 'player' ? 'enemy' : 'player');
  const lowestHp = Math.min(...foes.map((f) => f.hp));
  let score = 0;
  for (const v of p.victims) {
    const victim = state.units.find((u) => u.id === v.unitId)!;
    let s = (v.hit / 100) * v.damage;
    if (v.downs) s *= 2;
    if (victim.hp === lowestHp) s *= 1.2;
    score += victim.team === unit.team ? -s : s;
  }
  return score;
}

/**
 * Best offensive (tile, ability, target) over the given tiles. `adjust` rescales a score;
 * `preferred` breaks exact ties (rule 3). Ties otherwise keep the first in scan order.
 */
export function bestAttack(
  state: BattleState, unit: Unit, tiles: Point[],
  adjust: (p: ActionPreview, score: number) => number,
  preferred: (tile: Point) => boolean = () => false,
): AiPlan | null {
  let best: AiPlan | null = null;
  let bestPref = false;
  for (const t of tiles) {
    for (const abilityId of unit.abilities) {
      const a = ABILITIES[abilityId];
      if (!a || !isOffensive(a) || !abilityReady(unit, abilityId)) continue;
      for (const target of targetTiles(state, unit, abilityId, t)) {
        const p = previewAction(state, unit, abilityId, target, t);
        const score = adjust(p, expectedScore(state, unit, p));
        if (score <= 0) continue;
        const pref = preferred(t);
        const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && pref && !bestPref);
        if (better) {
          best = { unitId: unit.id, moveTo: t, action: { abilityId, target }, facing: facingToward(t, target, unit.facing), score, reason: `${abilityId} for ${score.toFixed(1)}` };
          bestPref = pref;
        }
      }
    }
  }
  return best;
}

/** Rule 5: close in on the nearest foe by path cost, ending on the furthest allowed tile along the path. */
export function advance(state: BattleState, unit: Unit, allowed: Point[]): AiPlan {
  const stay: AiPlan = { unitId: unit.id, moveTo: unit.pos, action: null, facing: unit.facing, score: 0, reason: 'wait' };
  const foes = living(state, unit.team === 'player' ? 'enemy' : 'player');
  if (!foes.length) return stay;
  const field = pathTree(state, unit, Infinity);
  let goal: { cost: number; pos: Point } | null = null;
  for (const f of foes) {
    for (const n of [{ x: f.pos.x + 1, y: f.pos.y }, { x: f.pos.x - 1, y: f.pos.y }, { x: f.pos.x, y: f.pos.y + 1 }, { x: f.pos.x, y: f.pos.y - 1 }]) {
      const node = field.get(key(n));
      if (node && (!goal || node.cost < goal.cost)) goal = { cost: node.cost, pos: n };
    }
  }
  if (!goal) return { ...stay, facing: facingToward(unit.pos, nearestFoe(state, unit, unit.pos)!.pos, unit.facing), reason: 'no path' };
  const reach = new Set(allowed.map(key));
  const path = pathTo(field, goal.pos);
  let dest = unit.pos;
  for (const p of path) {
    if (!reach.has(key(p))) break;
    if (!occupant(state, p)) dest = p;
  }
  const nf = nearestFoe(state, unit, dest)!;
  return { unitId: unit.id, moveTo: dest, action: null, facing: facingToward(dest, nf.pos, unit.facing), score: 0, reason: `advance toward ${nf.id}` };
}
