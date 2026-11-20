import { ABILITIES, RULES, type BattleSetup } from '../data';
import { abilityReady, inRange, previewAction } from './combat';
import { facingToward, key, samePoint } from './grid';
import { occupant, pathTo, pathTree } from './pathfinding';
import { nextRandom } from './rng';
import { teamMorale } from './stats';
import { advance } from './timeline';
import type { BattleEvent, Facing, GridMap, Point, Team, Unit, VictimResult } from './types';

/**
 * Extension points for systems layered on top of combat (vows, issue #9).
 * Defaults do nothing.
 */
export interface BattleHooks {
  hitBonus(state: BattleState, actor: Unit): number;
  atkBonus(state: BattleState, actor: Unit, from: Point): number;
}

export const NO_HOOKS: BattleHooks = { hitBonus: () => 0, atkBonus: () => 0 };

export interface BattleState {
  map: GridMap;
  units: Unit[];
  morale: Record<Team, number>;
  activeId: string | null;
  /** What the active unit has done this turn. */
  moved: boolean;
  acted: boolean;
  turnNumber: number;
  winner: Team | null;
  rngState: number;
  seed: number;
  events: BattleEvent[];
  hooks: BattleHooks;
}

export function createBattle(setup: BattleSetup, seed = 1): BattleState {
  const units: Unit[] = setup.units.map((s, i) => ({
    id: s.id,
    name: s.name,
    team: s.team,
    classId: s.classId,
    leader: s.leader,
    base: { ...s.stats },
    abilities: [...s.abilities],
    hp: s.stats.hp,
    pos: { ...s.pos },
    facing: s.facing,
    ct: 0,
    status: 'ok',
    reviveCounter: RULES.reviveCounter,
    cooldowns: {},
    usedOnce: [],
    modifiers: [],
    moraleMove: 0,
    xp: 0,
    defeats: 0,
    order: i,
    ai: s.ai,
  }));
  return {
    map: setup.map,
    units,
    morale: { player: RULES.morale.start, enemy: RULES.morale.start },
    activeId: null,
    moved: false,
    acted: false,
    turnNumber: 0,
    winner: null,
    rngState: seed,
    seed,
    events: [],
    hooks: NO_HOOKS,
  };
}

export function getUnit(state: BattleState, id: string): Unit {
  const u = state.units.find((x) => x.id === id);
  if (!u) throw new Error(`no unit ${id}`);
  return u;
}

export function activeUnit(state: BattleState): Unit | null {
  return state.activeId ? getUnit(state, state.activeId) : null;
}

const enemyOf = (t: Team): Team => (t === 'player' ? 'enemy' : 'player');

function emit(state: BattleState, e: BattleEvent): void {
  state.events.push(e);
}

export function changeMorale(state: BattleState, team: Team, delta: number, reason: string): void {
  const m = RULES.morale;
  const value = Math.max(m.min, Math.min(m.max, state.morale[team] + delta));
  if (value === state.morale[team]) return;
  state.morale[team] = value;
  emit(state, { type: 'morale', team, delta, value, reason });
}

function expireModifiers(state: BattleState, unitId: string, when: 'turnStart' | 'turnEnd'): void {
  for (const u of state.units) u.modifiers = u.modifiers.filter((m) => !(m.endsOn === when && m.endsWithUnit === unitId));
}

function checkWinner(state: BattleState): void {
  if (state.winner) return;
  for (const team of ['enemy', 'player'] as Team[]) {
    if (state.units.filter((u) => u.team === team).every((u) => u.status !== 'ok')) {
      state.winner = enemyOf(team);
      state.activeId = null;
      emit(state, { type: 'battleEnd', winner: state.winner });
      return;
    }
  }
}

/**
 * Advance the timeline to the next unit that can act and start its turn (§2).
 * Downed units reaching the threshold tick their revive counter instead.
 * Returns null when the battle is over.
 */
export function startNextTurn(state: BattleState): Unit | null {
  if (state.activeId) throw new Error('end the current turn first');
  for (;;) {
    checkWinner(state);
    if (state.winner) return null;
    const u = advance(state.units);
    if (!u) return null;
    if (u.status === 'downed') {
      u.ct = 0;
      u.reviveCounter -= 1;
      emit(state, { type: 'reviveTick', unitId: u.id, counter: u.reviveCounter });
      if (u.reviveCounter <= 0) {
        u.status = 'lost';
        emit(state, { type: 'lost', unitId: u.id });
      }
      continue;
    }
    state.activeId = u.id;
    state.moved = false;
    state.acted = false;
    state.turnNumber += 1;
    for (const id of Object.keys(u.cooldowns)) u.cooldowns[id] = Math.max(0, (u.cooldowns[id] ?? 0) - 1);
    expireModifiers(state, u.id, 'turnStart');
    u.moraleMove = teamMorale(state, u.team).move;
    emit(state, { type: 'turnStart', unitId: u.id });
    return u;
  }
}

function requireActive(state: BattleState, unitId: string): Unit {
  if (state.activeId !== unitId) throw new Error(`it is not ${unitId}'s turn`);
  return getUnit(state, unitId);
}

/** Move the active unit. Must come before acting (§2). Returns the path taken. */
export function moveUnit(state: BattleState, unitId: string, dest: Point): Point[] {
  const u = requireActive(state, unitId);
  if (state.moved || state.acted) throw new Error('already moved or acted');
  if (samePoint(u.pos, dest)) return [];
  const tree = pathTree(state, u);
  if (!tree.has(key(dest))) throw new Error('destination out of reach');
  const occ = occupant(state, dest);
  if (occ && occ.id !== u.id) throw new Error('destination occupied');
  const path = pathTo(tree, dest);
  const before = path.length > 1 ? path[path.length - 2]! : u.pos;
  u.facing = facingToward(before, dest, u.facing);
  u.pos = { ...dest };
  state.moved = true;
  emit(state, { type: 'move', unitId, path });
  return path;
}

/** Use an ability on a target tile. Ends the action phase; the turn ends with endTurn. */
export function useAbility(state: BattleState, unitId: string, abilityId: string, target: Point): VictimResult[] {
  const u = requireActive(state, unitId);
  if (state.acted) throw new Error('already acted');
  const a = ABILITIES[abilityId];
  if (!a || !u.abilities.includes(abilityId)) throw new Error(`${unitId} has no ability ${abilityId}`);
  if (!abilityReady(u, abilityId)) throw new Error(`${abilityId} is not ready`);
  if (a.type !== 'self' && !inRange(state, a, u.pos, target)) throw new Error('target out of range');
  const preview = previewAction(state, u, abilityId, target);
  if (!preview.victims.length) throw new Error('no valid target');

  if (a.type !== 'self' && !samePoint(u.pos, target)) u.facing = facingToward(u.pos, target, u.facing);
  const results: VictimResult[] = [];
  for (const v of preview.victims) {
    const t = getUnit(state, v.unitId);
    const hit = v.hit >= 100 || Math.floor(nextRandom(state) * 100) < v.hit;
    const r: VictimResult = { unitId: t.id, hit, damage: 0, heal: 0, hpAfter: t.hp };
    if (hit) {
      if (v.damage > 0) {
        t.hp = Math.max(0, t.hp - v.damage);
        r.damage = v.damage;
        if (v.pushedTo) t.pos = { ...v.pushedTo };
        r.pushedTo = v.pushedTo;
      }
      if (a.type === 'heal') {
        const wasDowned = t.status === 'downed';
        t.hp = Math.min(t.base.hp, t.hp + v.heal);
        r.heal = v.heal;
        if (wasDowned) {
          t.status = 'ok';
          t.reviveCounter = RULES.reviveCounter;
          emit(state, { type: 'revived', unitId: t.id, by: u.id });
          changeMorale(state, t.team, RULES.morale.events.allyRevived, 'ally revived');
        }
      }
      const buff = a.buff;
      if (buff) {
        t.modifiers.push({
          def: buff.def, res: buff.res, allFront: buff.allFront, source: abilityId,
          endsOn: buff.until === 'targetNextTurnEnd' ? 'turnEnd' : 'turnStart',
          endsWithUnit: buff.until === 'targetNextTurnEnd' ? t.id : u.id,
        });
      }
      if (a.debuff && t.hp > 0) {
        t.modifiers.push({ move: a.debuff.move, source: abilityId, endsOn: 'turnEnd', endsWithUnit: t.id });
      }
    }
    r.hpAfter = t.hp;
    results.push(r);
  }
  if (a.morale) changeMorale(state, u.team, a.morale, a.id);
  if (a.cd) u.cooldowns[abilityId] = a.cd;
  if (a.oncePerBattle) u.usedOnce.push(abilityId);
  u.xp += 10;
  state.acted = true;
  emit(state, { type: 'ability', unitId, abilityId, target, preview, results });

  // Downs after the event so listeners see cause then effect.
  for (const r of results) {
    const t = getUnit(state, r.unitId);
    if (t.hp === 0 && t.status === 'ok') downUnit(state, t, u);
  }
  checkWinner(state);
  return results;
}

function downUnit(state: BattleState, t: Unit, by: Unit | null): void {
  t.status = 'downed';
  t.reviveCounter = RULES.reviveCounter;
  t.modifiers = [];
  emit(state, { type: 'downed', unitId: t.id, by: by?.id ?? null });
  const ev = RULES.morale.events;
  changeMorale(state, t.team, ev.allyDowned, 'ally downed');
  if (t.leader) changeMorale(state, t.team, ev.leaderDefeated, 'leader defeated');
  if (by && by.team !== t.team) {
    by.defeats += 1;
    by.xp += 10;
    changeMorale(state, by.team, ev.enemyDefeated, 'enemy defeated');
  }
}

/** End the active unit's turn, optionally choosing a facing (§2, §4). */
export function endTurn(state: BattleState, facing?: Facing): void {
  if (!state.activeId) return;
  const u = getUnit(state, state.activeId);
  if (facing) u.facing = facing;
  const c = RULES.ctAfterTurn;
  u.ct = state.moved && state.acted ? c.movedAndActed : state.moved || state.acted ? c.oneOnly : c.waited;
  expireModifiers(state, u.id, 'turnEnd');
  emit(state, { type: 'turnEnd', unitId: u.id, facing: u.facing, ct: u.ct });
  state.activeId = null;
  checkWinner(state);
}
