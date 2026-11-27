import { advance, bestAttack, type AiPlan } from './ai';
import type { BattleState } from './battle';
import { abilityReady, previewAction, targetTiles } from './combat';
import { facingToward, heightAt, manhattan, samePoint } from './grid';
import { reachableTiles } from './pathfinding';
import { vowOf, adjacentAllies } from './vows';
import type { Point, Unit } from './types';

/**
 * Scripted squad AI for balance sims (Game Design's rules, Nov 20). Not used for the
 * player in the real game; it stands in for a sensible human so the patrol can be tuned.
 *
 * Interpretations:
 * - "6 squad rounds" = 6 turns per squad unit, i.e. squad turns taken ≥ 6 × squad size.
 * - Hold applies to where a unit ends its move; attacks from a held tile are allowed.
 * - Rule 7 (cohesion) applies to melee units other than Tobin-with-intact-Lone-Blade.
 */
export interface SquadMemory { squadTurns: number; squadSize: number }

export function newSquadMemory(state: BattleState): SquadMemory {
  return { squadTurns: 0, squadSize: state.units.filter((u) => u.team === 'player').length };
}

const HILL: Point = { x: 2, y: 7 };
export const TUNE = { braceReach: 4, mendGuardianBelow: 0.9, callaKeepAway: 4 };
const ok = (state: BattleState, team: string) => state.units.filter((u) => u.team === team && u.status === 'ok');
const isMelee = (u: Unit) => u.classId === 'sellsword';

function holding(state: BattleState, mem: SquadMemory): boolean {
  const enemyCrossed = ok(state, 'enemy').some((e) => e.pos.y >= 5);
  return !enemyCrossed && mem.squadTurns < 6 * mem.squadSize;
}

function nearestEnemyDist(state: BattleState, p: Point): number {
  return Math.min(...ok(state, 'enemy').map((e) => manhattan(e.pos, p)));
}

export function planSquadTurn(state: BattleState, unit: Unit, mem: SquadMemory): AiPlan {
  mem.squadTurns += 1;
  const hold = holding(state, mem);
  const vow = vowOf(state, unit.id);
  const loneBladeIntact = vow?.vowId === 'loneBlade' && vow.status === 'intact' && !vow.frozen;
  const all = reachableTiles(state, unit).sort((a, b) => a.cost - b.cost || a.pos.y - b.pos.y || a.pos.x - b.pos.x).map((n) => n.pos);

  // Rule 3: hold the line below row 6.
  let tiles = hold ? all.filter((p) => p.y >= 6 || samePoint(p, unit.pos)) : all;
  // Rule 7: melee cohesion, within 3 of the nearest ally.
  if (isMelee(unit) && !loneBladeIntact) {
    const allies = ok(state, 'player').filter((a) => a.id !== unit.id);
    const close = tiles.filter((p) => allies.some((a) => manhattan(a.pos, p) <= 3));
    if (close.length) tiles = close;
  }
  // Rule 5: Maren (Bulwark) ends next to Calla or Wren, closest to the enemy.
  if (vow?.vowId === 'bulwark' && (vow.status === 'intact' || vow.status === 'fulfilled')) {
    const wards = ok(state, 'player').filter((a) => a.classId === 'hedgeMage' || a.classId === 'bowhand');
    const near = tiles.filter((p) => wards.some((w) => manhattan(w.pos, p) === 1));
    if (near.length) tiles = near.sort((a, b) => nearestEnemyDist(state, a) - nearestEnemyDist(state, b));
  }
  const stayFacing = () => facingToward(unit.pos, ok(state, 'enemy')[0]?.pos ?? unit.pos, unit.facing);

  // Rule 2: Calla's support priorities.
  if (unit.classId === 'hedgeMage') {
    const support = callaSupport(state, unit, tiles);
    if (support) return support;
    // Rule 2c (Nov 27): Calla attacks only from tiles at least TUNE.callaKeepAway from every foe, if any exist.
    const safe = tiles.filter((p) => nearestEnemyDist(state, p) >= TUNE.callaKeepAway);
    if (safe.length) tiles = safe;
  }

  // Rule 4: Sellsword braces under melee pressure when it can't down anyone.
  // Rule 4b (Nov 27): a Bulwark guardian braces at any HP when a melee foe is within TUNE.braceReach tiles.
  const guarding = vow?.vowId === 'bulwark' && vow.status === 'intact';
  if (isMelee(unit) && abilityReady(unit, 'brace') && (guarding || unit.hp < unit.base.hp * 0.6)) {
    const reach = guarding ? TUNE.braceReach : 1;
    const meleeAdjacent = ok(state, 'enemy').some((e) => manhattan(e.pos, unit.pos) <= reach && e.abilities.some((a) => a === 'strike' || a === 'thrust' || a === 'cleave'));
    const canDown = bestAttack(state, unit, tiles, (p, s) => (p.victims.some((v) => v.downs) ? s : 0));
    if (meleeAdjacent && !canDown) {
      return { unitId: unit.id, moveTo: unit.pos, action: { abilityId: 'brace', target: unit.pos }, facing: stayFacing(), score: 1, reason: 'brace' };
    }
  }

  // Rule 3 (Wren): take the hill, then shoot from it.
  if (unit.classId === 'bowhand' && hold) {
    const high = tiles.filter((p) => heightAt(state.map, p) >= 2).sort((a, b) => manhattan(a, HILL) - manhattan(b, HILL));
    const spot = high.find((p) => samePoint(p, HILL)) ?? high[0];
    if (spot) {
      const shot = bestAttack(state, unit, [spot], (_p, s) => s);
      return shot ?? { unitId: unit.id, moveTo: spot, action: null, facing: facingToward(spot, ok(state, 'enemy')[0]?.pos ?? spot, unit.facing), score: 0, reason: 'take the hill' };
    }
  }

  // Rule 6: Tobin's Lone Blade scoring.
  const adjust = (p: ReturnType<typeof previewAction>, s: number) => {
    if (!loneBladeIntact) return s;
    const downs = p.victims.some((v) => v.downs);
    if (!downs) return s;
    return adjacentAllies(state, unit, p.from).length === 0 ? s * 1.5 : 0;
  };
  const attack = bestAttack(state, unit, tiles, adjust);
  if (attack) return attack;

  if (hold) {
    return { unitId: unit.id, moveTo: unit.pos, action: null, facing: stayFacing(), score: 0, reason: 'holding the line' };
  }
  const plan = advance(state, unit, tiles);
  // Bulwark: if advancing would leave her wards, prefer the best ward-adjacent tile instead.
  if (vow?.vowId === 'bulwark' && tiles.length && !tiles.some((t) => samePoint(t, plan.moveTo))) {
    return { ...plan, moveTo: tiles[0]!, reason: 'guard' };
  }
  return plan;
}

function callaSupport(state: BattleState, unit: Unit, tiles: Point[]): AiPlan | null {
  const allies = state.units.filter((u) => u.team === unit.team && u.status !== 'lost');
  const canTarget = (abilityId: string, who: Unit): Point | null => {
    if (!abilityReady(unit, abilityId)) return null;
    for (const t of tiles) {
      if (targetTiles(state, unit, abilityId, t).some((p) => samePoint(p, who.pos))) return t;
    }
    return null;
  };
  const act = (abilityId: string, who: Unit, from: Point, reason: string): AiPlan =>
    ({ unitId: unit.id, moveTo: from, action: { abilityId, target: who.pos }, facing: facingToward(from, who.pos, unit.facing), score: 1, reason });

  // Rule 2b (Nov 27): the Bulwark guardian comes first for revives and Mends.
  const guardian = (a: Unit) => (vowOf(state, a.id)?.vowId === 'bulwark' ? 0 : 1);
  const downed = allies.filter((a) => a.status === 'downed').sort((a, b) => guardian(a) - guardian(b) || a.reviveCounter - b.reviveCounter || a.order - b.order);
  for (const d of downed) {
    const from = canTarget('mend', d);
    if (from) return act('mend', d, from, `revive ${d.id}`);
  }
  const hurt = allies.filter((a) => a.status === 'ok' && a.hp < a.base.hp * (guardian(a) === 0 ? TUNE.mendGuardianBelow : 0.5)).sort((a, b) => guardian(a) - guardian(b) || a.hp - b.hp || a.order - b.order);
  for (const h of hurt) {
    const from = canTarget('mend', h);
    if (from) return act('mend', h, from, `mend ${h.id}`);
  }
  const pressed = allies.filter((a) => a.status === 'ok' && ok(state, 'enemy').some((e) => manhattan(e.pos, a.pos) === 1));
  for (const p of pressed) {
    const from = canTarget('ward', p);
    if (from) return act('ward', p, from, `ward ${p.id}`);
  }
  return null;
}
