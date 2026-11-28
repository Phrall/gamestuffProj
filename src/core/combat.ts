import { ABILITIES, RULES } from '../data';
import { JOB_DATA } from './jobs';
import type { BattleState } from './battle';
import { DIRS, facingToward, heightAt, inBounds, isPassable, manhattan, tileAt } from './grid';
import { occupant, stepCost } from './pathfinding';
import { effectiveStats, hardToKillReady, teamMorale } from './stats';
import { adjacentAllies, guardianFor, loneBladeAtk, mercyBreaks, wouldBreakOwnVow } from './vows';
import type { AbilityDef, ActionPreview, Point, Side, Unit, VictimPreview } from './types';

/** Hard to Kill v3: the minimum share of max HP (percent) for the save (job-system.json). */
export const HARD_TO_KILL_MIN_PCT = JOB_DATA.traits.hardToKill.minPct;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Which side of `target` an attack from `from` lands on (§4). */
export function attackSide(from: Point, target: Unit, allFront = false): Side {
  if (allFront) return 'front';
  const dx = from.x - target.pos.x;
  const dy = from.y - target.pos.y;
  const f = DIRS[target.facing];
  const along = dx * f.x + dy * f.y;
  const across = dx * -f.y + dy * f.x;
  if (Math.abs(along) >= Math.abs(across) && along !== 0) return along > 0 ? 'front' : 'back';
  return 'side';
}

export function isOffensive(a: AbilityDef): boolean {
  return a.type === 'phys' || a.type === 'magic';
}

/** Max range including the ranged height bonus (§3). */
export function maxRange(state: BattleState, a: AbilityDef, from: Point, target: Point): number {
  const [, max] = a.range ?? [0, 0];
  const b = RULES.rangedHeightBonus;
  const dh = heightAt(state.map, from) - heightAt(state.map, target);
  return max >= b.minMaxRange && dh >= b.heightAdvantage ? max + b.bonus : max;
}

export function inRange(state: BattleState, a: AbilityDef, from: Point, target: Point): boolean {
  const [min] = a.range ?? [0, 0];
  const d = manhattan(from, target);
  if (d < min || d > maxRange(state, a, from, target)) return false;
  if (a.straightLine && from.x !== target.x && from.y !== target.y) return false;
  return true;
}

/** Tiles affected when `a` is aimed at `target` from `from`. */
export function areaTiles(state: BattleState, a: AbilityDef, from: Point, target: Point): Point[] {
  const pts: Point[] = [target];
  if (a.area === 'plus') {
    for (const d of Object.values(DIRS)) pts.push({ x: target.x + d.x, y: target.y + d.y });
  } else if (a.area === 'perpendicularLine3') {
    const f = DIRS[facingToward(from, target)];
    pts.push({ x: target.x - f.y, y: target.y + f.x }, { x: target.x + f.y, y: target.y - f.x });
  }
  return pts.filter((p) => inBounds(state.map, p));
}

/** Can `actor` use this ability now (ignoring targets)? */
export function abilityReady(actor: Unit, abilityId: string): boolean {
  const a = ABILITIES[abilityId];
  if (!a || a.type === 'passive') return false;
  if ((actor.cooldowns[abilityId] ?? 0) > 0) return false;
  if (a.oncePerBattle && actor.usedOnce.includes(abilityId)) return false;
  return true;
}

/** Is `u` a valid victim of this ability from `actor`? */
function affects(a: AbilityDef, actor: Unit, u: Unit): boolean {
  if (u.status === 'lost') return false;
  if (a.type === 'heal') return u.team === actor.team && (u.status === 'ok' || !!a.revives);
  if (a.type === 'buff') return u.team === actor.team && u.status === 'ok';
  if (a.type === 'self') return u.id === actor.id;
  if (u.status !== 'ok') return false;
  if (a.type === 'debuff') return u.team !== actor.team;
  if (u.team === actor.team) return !!a.area && !!a.hitsAllies;
  return true;
}

/**
 * Target tiles the actor could aim at from `from`. Single-target abilities need a valid
 * unit on the tile; area abilities can aim at any tile in range that would hit someone.
 */
export function targetTiles(state: BattleState, actor: Unit, abilityId: string, from: Point = actor.pos): Point[] {
  const a = ABILITIES[abilityId];
  if (!a || !abilityReady(actor, abilityId)) return [];
  if (a.type === 'self') return [from];
  const out: Point[] = [];
  for (let y = 0; y < state.map.height; y++) {
    for (let x = 0; x < state.map.width; x++) {
      const p = { x, y };
      if (!inRange(state, a, from, p)) continue;
      if (previewAction(state, actor, abilityId, p, from).victims.length) out.push(p);
    }
  }
  return out;
}

/** Shove outcome for a target standing at `t`, pushed away from `from` (§10 Shove). */
function shoveOutcome(state: BattleState, a: AbilityDef, from: Point, t: Unit): { to?: Point; bonus: number } {
  const f = DIRS[facingToward(from, t.pos)];
  const dest = { x: t.pos.x + f.x * (a.push ?? 1), y: t.pos.y + f.y * (a.push ?? 1) };
  const tile = tileAt(state.map, dest);
  const h0 = heightAt(state.map, t.pos);
  const blocked = !tile || !isPassable(tile) || !!occupant(state, dest) || tile.height - h0 >= 2;
  if (blocked) return { bonus: a.blockedBonus ?? 0 };
  const drop = h0 - tile.height;
  return { to: dest, bonus: drop >= (a.fallMinDrop ?? 2) ? (a.fallBonus ?? 0) : 0 };
}

export function hitChance(state: BattleState, actor: Unit, a: AbilityDef, from: Point, target: Unit, side: Side): number {
  if (a.type !== 'phys') return 100;
  const h = RULES.hit;
  const ranged = !a.melee;
  const dh = heightAt(state.map, from) - heightAt(state.map, target.pos);
  const eva = target.base.eva * h.evaFactor[side];
  const hit =
    (ranged ? h.baseRanged : h.baseMelee) -
    eva +
    clamp(dh * h.perHeightLevel, -h.heightCap, h.heightCap) +
    teamMorale(state, actor.team).hit +
    (a.hitBonus ?? 0) +
    (h.addHitBonus ? actor.base.hitBonus ?? 0 : 0) +
    (a.hitBonusAlone && adjacentAllies(state, actor, from).length === 0 ? a.hitBonusAlone : 0) +
    effectiveStats(state, actor).hit;
  // §13.1: clamp, then floor; the roll uses the same integer.
  return Math.floor(clamp(hit, h.min, h.max));
}

export function damageAmount(state: BattleState, actor: Unit, a: AbilityDef, from: Point, target: Unit, side: Side): number {
  const as = effectiveStats(state, actor);
  const ts = effectiveStats(state, target);
  const d = RULES.damage;
  const atk = as.atk + loneBladeAtk(state, actor, from);
  const raw = a.type === 'magic' ? (a.power ?? 0) + as.mag - ts.res : (a.power ?? 0) + atk - ts.def;
  const dh = heightAt(state.map, from) - heightAt(state.map, target.pos);
  let mult = 1 + clamp(dh * d.perHeightLevel, -d.heightCap, d.heightCap) + teamMorale(state, actor.team).dmg;
  if (a.type === 'phys') mult += d.facing[side];
  mult = Math.round(mult * 100) / 100;
  return Math.max(d.min, Math.floor(raw * mult + 1e-9));
}

export function healAmount(state: BattleState, actor: Unit): number {
  return RULES.heal.base + Math.floor(effectiveStats(state, actor).mag / RULES.heal.magDivisor);
}

/**
 * Exact preview of using an ability (§5, §6). Pure: does not change state.
 * `from` lets the AI evaluate a tile before moving there.
 */
export function previewAction(state: BattleState, actor: Unit, abilityId: string, target: Point, from: Point = actor.pos): ActionPreview {
  const a = ABILITIES[abilityId];
  const preview: ActionPreview = { actorId: actor.id, abilityId, from, target, victims: [], breaksVow: false };
  if (!a) return preview;
  // Lunge strikes from the tile it steps onto.
  if (a.lunge) {
    const step = lungeStep(state, actor, from, target);
    if (!step) return preview;
    from = step;
  }
  const tiles = a.type === 'self' ? [from] : areaTiles(state, a, from, target);
  for (const p of tiles) {
    const isCenter = p.x === target.x && p.y === target.y;
    // The actor may be previewing from another tile; treat it as standing there.
    const u = a.type === 'self' ? actor : occupantAt(state, actor, from, p);
    if (!u || !affects(a, actor, u)) continue;
    if (!a.area && !isCenter) continue;
    // Bulwark Guard takes single-target attacks aimed at an adjacent ally (§9).
    const guard = isOffensive(a) && !a.area ? guardianFor(state, actor, u) : undefined;
    if (guard && guard.id !== actor.id) {
      preview.interceptedBy = guard.id;
      preview.victims.push(previewVictim(state, actor, a, from, guard, true));
    } else {
      preview.victims.push(previewVictim(state, actor, a, from, u));
    }
  }
  preview.breaksVow = wouldBreakOwnVow(state, actor, from, preview.victims.some((v) => v.downs && getTeam(state, v.unitId) !== actor.team)) || mercyBreaks(state, actor, preview.victims);
  return preview;
}

function occupantAt(state: BattleState, actor: Unit, from: Point, p: Point): Unit | undefined {
  if (p.x === from.x && p.y === from.y) return actor;
  const o = occupant(state, p);
  return o && o.id === actor.id ? undefined : o;
}

function getTeam(state: BattleState, id: string) {
  return state.units.find((u) => u.id === id)?.team;
}

export function previewVictim(state: BattleState, actor: Unit, a: AbilityDef, from: Point, u: Unit, forceFront = false): VictimPreview {
  const ts = effectiveStats(state, u);
  const side = attackSide(from, u, ts.allFront || forceFront);
  const dh = heightAt(state.map, from) - heightAt(state.map, u.pos);
  const base: VictimPreview = { unitId: u.id, hit: 100, damage: 0, heal: 0, hpAfter: u.hp, side, heightDiff: dh, downs: false, revives: false };
  if (a.type === 'heal') {
    const heal = Math.min(healAmount(state, actor), u.base.hp - u.hp);
    return { ...base, heal, hpAfter: u.hp + heal, revives: u.status === 'downed' };
  }
  if (!isOffensive(a)) return base;
  let damage = damageAmount(state, actor, a, from, u, side);
  let pushedTo: Point | undefined;
  if (a.push) {
    const s = shoveOutcome(state, a, from, u);
    damage += s.bonus;
    pushedTo = s.to;
  }
  // Hard to Kill v3 (Game Design, Nov 27): once per battle, a hit that would down the unit leaves it at 1 HP,
  // but only if the unit had at least 20% of its max HP before the hit.
  const survives = damage >= u.hp && u.status === 'ok' && hardToKillReady(u) && u.hp * 100 >= u.base.hp * HARD_TO_KILL_MIN_PCT ? 'hardToKill' : undefined;
  if (survives) damage = u.hp - 1;
  const hpAfter = Math.max(0, u.hp - damage);
  return { ...base, hit: hitChance(state, actor, a, from, u, side), damage, hpAfter, downs: hpAfter === 0, pushedTo, ...(survives ? { survives } : {}) };
}

/** The tile a Lunge steps onto: 1 tile toward the target, free and enterable (slice spec §3). */
export function lungeStep(state: BattleState, actor: Unit, from: Point, target: Point): Point | null {
  if (manhattan(from, target) !== 2 || (from.x !== target.x && from.y !== target.y)) return null;
  const mid = { x: (from.x + target.x) / 2, y: (from.y + target.y) / 2 };
  const o = occupant(state, mid);
  if (o && o.id !== actor.id) return null;
  return stepCost(state, actor, from, mid) === null ? null : mid;
}
