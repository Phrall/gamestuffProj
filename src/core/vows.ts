import { RULES, VOWS } from '../data';
import { changeMorale, emit, type BattleState } from './battle';
import { manhattan } from './grid';
import type { Point, Unit, VowId, VowState } from './types';

// Vows (§9, §13.3, §13.4). Bulwark: Guard intercepts single-target attacks on adjacent
// allies. Lone Blade: +1 Atk with no ally adjacent; progress on solo defeats.

type VowDef = (typeof VOWS)['bulwark'] | (typeof VOWS)['loneBlade'] | (typeof VOWS)['mercy'];
export function vowDef(id: VowId): VowDef & { name: string; goal: number; kept: { resolve: number }; broken: { shadow: number; surge: object } } {
  return VOWS[id];
}

/** Swear a vow before the battle starts. One per unit. */
export function swearVow(state: BattleState, unitId: string, vowId: VowId): void {
  const goal = vowDef(vowId).goal;
  state.vows[unitId] = { vowId, status: 'intact', progress: 0, goal, frozen: false };
  emit(state, { type: 'vowSworn', unitId, vowId });
}

export function vowOf(state: BattleState, unitId: string): VowState | undefined {
  return state.vows[unitId];
}

const liveVow = (v: VowState | undefined): v is VowState => !!v && v.status === 'intact' && !v.frozen;

/** Allies of `u` (status ok) orthogonally adjacent to point `p`, excluding `u` itself. */
export function adjacentAllies(state: BattleState, u: Unit, p: Point): Unit[] {
  return state.units.filter((o) => o.id !== u.id && o.team === u.team && o.status === 'ok' && manhattan(o.pos, p) === 1);
}

/** Lone Blade while sworn (intact or fulfilled): +1 Atk with no ally adjacent to where the unit stands. */
export function loneBladeAtk(state: BattleState, u: Unit, from: Point): number {
  const v = state.vows[u.id];
  if (!v || v.vowId !== 'loneBlade' || (v.status !== 'intact' && v.status !== 'fulfilled')) return 0;
  return adjacentAllies(state, u, from).length === 0 ? VOWS.loneBlade.whileSworn.atkWhenAlone : 0;
}

/**
 * The Bulwark unit that would take a single-target attack aimed at `target`, if any (§13.4:
 * whenever the target is adjacent, whatever the attacker's range).
 */
export function guardianFor(state: BattleState, attacker: Unit, target: Unit): Unit | undefined {
  if (target.team === attacker.team) return undefined;
  return state.units
    .filter((g) => {
      const v = state.vows[g.id];
      return g.id !== target.id && g.team === target.team && g.status === 'ok' && v?.vowId === 'bulwark' &&
        (v.status === 'intact' || v.status === 'fulfilled') && manhattan(g.pos, target.pos) <= VOWS.bulwark.guardRadius;
    })
    .sort((a, b) => a.order - b.order)[0];
}

/** Would this action break the actor's own vow? (Lone Blade: downing a foe with an ally adjacent.) */
export function wouldBreakOwnVow(state: BattleState, actor: Unit, from: Point, downsFoe: boolean): boolean {
  const v = state.vows[actor.id];
  return liveVow(v) && v.vowId === 'loneBlade' && downsFoe && adjacentAllies(state, actor, from).length > 0;
}

function fulfil(state: BattleState, u: Unit, v: VowState): void {
  v.status = 'fulfilled';
  emit(state, { type: 'vowFulfilled', unitId: u.id, vowId: v.vowId });
  changeMorale(state, u.team, RULES.morale.events.vowFulfilled, 'vow fulfilled');
}

/** v1.7 Bulwark Alt A: the vow is judged at battle end, so it stays breakable after the goal is met. */
const resolvesAtEnd = (v: VowState): boolean => (vowDef(v.vowId) as { resolvesAt?: string }).resolvesAt === 'battleEnd';

function progress(state: BattleState, u: Unit, v: VowState): void {
  if (resolvesAtEnd(v) && v.progress >= v.goal) return; // goal met; nothing more to count
  v.progress += 1;
  emit(state, { type: 'vowProgress', unitId: u.id, vowId: v.vowId, progress: v.progress, goal: v.goal });
  if (v.progress >= v.goal && !resolvesAtEnd(v)) fulfil(state, u, v);
}

function breakVow(state: BattleState, u: Unit, v: VowState, cause: string): void {
  v.status = 'broken';
  const surge = vowDef(v.vowId).broken.surge as { atk?: number; move?: number; hit?: number };
  u.modifiers.push({ atk: surge.atk, move: surge.move, hit: surge.hit, source: `${v.vowId}Surge`, endsOn: 'battleEnd', endsWithUnit: u.id });
  emit(state, { type: 'vowBroken', unitId: u.id, vowId: v.vowId, cause });
  changeMorale(state, u.team, RULES.morale.events.vowBroken, 'vow broken');
}

export function onIntercept(state: BattleState, guardianId: string, _protectedId: string, attackerId: string, target: Point): void {
  const g = state.units.find((u) => u.id === guardianId)!;
  const protectedUnit = state.units.find((u) => u.status !== 'lost' && u.pos.x === target.x && u.pos.y === target.y);
  emit(state, { type: 'intercept', unitId: guardianId, protectedId: protectedUnit?.id ?? '', attackerId });
  const v = state.vows[guardianId];
  if (liveVow(v)) progress(state, g, v);
}

/** Called after `t` is downed (by `by`, if an attack). */
export function onDowned(state: BattleState, t: Unit, by: Unit | null): void {
  // A sworn unit downed with its vow intact freezes it (§13.3).
  const own = state.vows[t.id];
  if (liveVow(own)) {
    own.frozen = true;
    emit(state, { type: 'vowFrozen', unitId: t.id, vowId: own.vowId });
  }
  // Bulwark breaks when an ally within the radius is downed.
  for (const g of state.units) {
    const v = state.vows[g.id];
    if (g.id === t.id || g.team !== t.team || !liveVow(v) || v.vowId !== 'bulwark') continue;
    if (manhattan(g.pos, t.pos) <= VOWS.bulwark.breakRadius) breakVow(state, g, v, `${t.name} fell`);
  }
  // Lone Blade: progress on a solo defeat, breaks on a defeat with an ally adjacent.
  if (by && by.team !== t.team) {
    const v = state.vows[by.id];
    if (liveVow(v) && v.vowId === 'loneBlade') {
      if (adjacentAllies(state, by, by.pos).length === 0) progress(state, by, v);
      else breakVow(state, by, v, `defeated ${t.name} with an ally beside`);
    }
  }
}

/** Mercy (slice spec §4): the sworn unit damaging a yielding foe breaks it. */
export function mercyBreaks(state: BattleState, actor: Unit, victims: { unitId: string; damage: number }[]): boolean {
  const v = state.vows[actor.id];
  if (!liveVow(v) || v.vowId !== 'mercy') return false;
  return victims.some((x) => {
    const t = state.units.find((u) => u.id === x.unitId);
    return x.damage > 0 && !!t?.yielding && t.team !== actor.team;
  });
}

/** After an ability lands. */
export function onStrike(state: BattleState, actor: Unit, results: { unitId: string; damage: number }[]): void {
  if (!mercyBreaks(state, actor, results)) return;
  const struck = state.units.find((u) => u.yielding && results.some((r) => r.unitId === u.id && r.damage > 0));
  breakVow(state, actor, state.vows[actor.id]!, `struck ${struck?.name ?? 'a yielding foe'}`);
}

/** A yielding foe left the map alive: every live Mercy vow on the other side counts it. */
export function onSpared(state: BattleState, foe: Unit): void {
  for (const u of state.units) {
    const v = state.vows[u.id];
    if (u.team !== foe.team && liveVow(v) && v.vowId === 'mercy') progress(state, u, v);
  }
}

/** Battle over: intact vows lapse, frozen ones resolve (§9, §13.3). */
export function resolveVowsAtEnd(state: BattleState): void {
  // Yielding foes still alive at the end count as spared (slice spec §4).
  for (const f of state.units) if (f.yielding && f.status === 'ok') onSpared(state, f);
  for (const v of Object.values(state.vows)) {
    if (v.status !== 'intact') continue;
    // Kept at the end fires the same event and +10 morale as an early Kept, for the Reckoning.
    const u = state.units.find((x) => state.vows[x.id] === v);
    // Director ruling (Nov 27, replaces QA ruling 3): a frozen vow is Kept only if its unit is standing at the end.
    if (v.frozen && u && u.status !== 'ok') v.status = 'lapsed';
    else if (v.progress >= v.goal && u) fulfil(state, u, v);
    else v.status = 'lapsed';
  }
}

export interface VowReckoning { unitId: string; vowId: VowId; status: VowState['status']; resolve: number; shadow: number }

/** Resolve and Shadow earned per vow, for the Reckoning screen (#10). */
export function reckonVows(state: BattleState): VowReckoning[] {
  return Object.entries(state.vows).map(([unitId, v]) => ({
    unitId,
    vowId: v.vowId,
    status: v.status,
    resolve: v.status === 'fulfilled' ? vowDef(v.vowId).kept.resolve : 0,
    shadow: v.status === 'broken' ? vowDef(v.vowId).broken.shadow : 0,
  }));
}
