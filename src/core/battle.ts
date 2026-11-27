import { ABILITIES, RULES, SLICE, type BattleSetup, type UnitSetup } from '../data';
import { abilityReady, inRange, lungeStep, previewAction } from './combat';
import { facingToward, isPassable, key, manhattan, samePoint, tileAt } from './grid';
import { occupant, pathTo, pathTree } from './pathfinding';
import { nextRandom } from './rng';
import { hasPassive, teamMorale } from './stats';
import { advance } from './timeline';
import type { BattleEvent, Facing, GridMap, Point, Team, TwistState, Unit, VictimResult, VowState } from './types';
import { onDowned, onIntercept, onSpared, onStrike, resolveVowsAtEnd } from './vows';

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
  /** Sworn vows by unit id (§9). */
  vows: Record<string, VowState>;
  /** Scripted twists for this battle (slice spec §10), in data order. */
  twists: (TwistState & { units: UnitSetup[] })[];
}

function makeUnit(s: UnitSetup, order: number): Unit {
  return {
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
    order,
    ai: s.ai,
    traits: [...(s.traits ?? [])],
    yieldBelow: s.yieldBelow,
    yielding: false,
    fled: false,
    civilian: !!s.civilian,
    escapeEdge: s.escapeEdge,
    prefers: s.prefers,
  };
}

export function createBattle(setup: BattleSetup, seed = 1): BattleState {
  return {
    map: setup.map,
    units: setup.units.map(makeUnit),
    morale: { player: RULES.morale.start, enemy: RULES.morale.start },
    activeId: null,
    moved: false,
    acted: false,
    turnNumber: 0,
    winner: null,
    rngState: seed,
    seed,
    events: [],
    vows: {},
    twists: (setup.twists ?? []).map(({ units, ...def }) => ({ def, units, announced: false, fired: false })),
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

export function emit(state: BattleState, e: BattleEvent): void {
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
    // Civilians (villagers) are not needed for the win or the loss (slice spec §5).
    const wiped = state.units.filter((u) => u.team === team && !u.civilian).every((u) => u.status !== 'ok');
    // Units a spawn twist has yet to bring in count toward the win condition (slice spec §10).
    // If the side is cleared early, the wave is pulled forward: announced next turn, arriving the turn after.
    const pending = state.twists.filter((t) => !t.fired && t.def.effect === 'spawn' && t.units.some((s) => s.team === team));
    if (wiped) for (const t of pending) t.def.firesAtTurn = Math.min(t.def.firesAtTurn, state.turnNumber + 1 + t.def.announceTurnsAhead);
    if (!pending.length && wiped) {
      state.winner = enemyOf(team);
      state.activeId = null;
      resolveVowsAtEnd(state);
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
    runTwists(state);
    for (const id of Object.keys(u.cooldowns)) u.cooldowns[id] = Math.max(0, (u.cooldowns[id] ?? 0) - 1);
    expireModifiers(state, u.id, 'turnStart');
    u.moraleMove = teamMorale(state, u.team).move;
    emit(state, { type: 'turnStart', unitId: u.id });
    // Ember ticks first; a unit it downs loses its turn.
    if (!tickDots(state, u)) {
      u.ct = 0;
      emit(state, { type: 'turnEnd', unitId: u.id, facing: u.facing, ct: 0 });
      state.activeId = null;
      checkWinner(state);
      continue;
    }
    turnStartTraits(state, u);
    // Yield (slice spec §4): checked at the start of the unit's turn.
    if (u.yieldBelow !== undefined && !u.yielding && u.hp <= Math.floor(u.base.hp * u.yieldBelow)) {
      u.yielding = true;
      emit(state, { type: 'yield', unitId: u.id });
    }
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

  // Lunge: step onto the tile next to the target first (slice spec §3).
  if (a.lunge) {
    const step = lungeStep(state, u, u.pos, target)!;
    emit(state, { type: 'move', unitId, path: [step] });
    u.pos = { ...step };
  }
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
        if (v.survives) {
          t.usedOnce.push(`trait:${v.survives}`);
          emit(state, { type: 'trait', unitId: t.id, traitId: v.survives });
        }
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
          def: buff.def, res: buff.res, allFront: buff.allFront, guardReach: buff.guardReach, source: abilityId,
          endsOn: buff.until === 'targetNextTurnEnd' ? 'turnEnd' : 'turnStart',
          endsWithUnit: buff.until === 'targetNextTurnEnd' ? t.id : u.id,
        });
      }
      if (a.debuff && t.hp > 0) {
        t.modifiers.push({ move: a.debuff.move, noWaitBonus: a.debuff.noWaitBonus, tauntBy: a.debuff.taunt ? u.id : undefined, source: abilityId, endsOn: 'turnEnd', endsWithUnit: t.id });
      }
      // Ember: ticks at the start of the target's next turns (a new cast replaces the old one).
      if (a.dot && t.hp > 0) {
        t.modifiers = t.modifiers.filter((m) => m.source !== abilityId || !m.dot);
        t.modifiers.push({ dot: { damage: a.dot.damage, left: a.dot.turns, by: u.id }, source: abilityId, endsOn: 'battleEnd', endsWithUnit: t.id });
      }
      // Feint: the target turns its back to the attacker.
      if (a.turnsTarget && t.hp > 0) t.facing = facingToward(u.pos, t.pos, t.facing);
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
  if (preview.interceptedBy) onIntercept(state, preview.interceptedBy, preview.victims[0]?.unitId ?? '', u.id, target);
  onStrike(state, u, results);

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
  t.modifiers = t.modifiers.filter((m) => m.endsOn === 'battleEnd');
  emit(state, { type: 'downed', unitId: t.id, by: by?.id ?? null });
  const ev = RULES.morale.events;
  // Civilians move no morale either way (Programming's call; Game Design to confirm).
  if (!t.civilian) changeMorale(state, t.team, ev.allyDowned, 'ally downed');
  if (t.leader) changeMorale(state, t.team, ev.leaderDefeated, 'leader defeated');
  if (by && by.team !== t.team) {
    by.defeats += 1;
    by.xp += 10;
    if (!t.civilian) changeMorale(state, by.team, ev.enemyDefeated, 'enemy defeated');
  }
  onDowned(state, t, by);
  // Defeated enemies and civilians leave the board at once; only squad units get a revive window (§8).
  if (t.team === 'enemy' || t.civilian) {
    t.status = 'lost';
    emit(state, { type: 'lost', unitId: t.id });
  }
}

/** End the active unit's turn, optionally choosing a facing (§2, §4). */
export function endTurn(state: BattleState, facing?: Facing): void {
  if (!state.activeId) return;
  const u = getUnit(state, state.activeId);
  if (facing) u.facing = facing;
  const c = RULES.ctAfterTurn;
  // Torch: a Wait gives only the one-action CT.
  const waited = u.modifiers.some((m) => m.noWaitBonus) ? c.oneOnly : c.waited;
  u.ct = state.moved && state.acted ? c.movedAndActed : state.moved || state.acted ? c.oneOnly : waited;
  expireModifiers(state, u.id, 'turnEnd');
  emit(state, { type: 'turnEnd', unitId: u.id, facing: u.facing, ct: u.ct });
  state.activeId = null;
  // A yielding foe or a civilian that ends its turn on its edge leaves the map (slice spec §4-5).
  if ((u.yielding || u.civilian) && onEscapeEdge(state, u)) flee(state, u);
  checkWinner(state);
}

// ---------- twists (slice spec §10) ----------

/** Where a spawn lands: its own tile, or the nearest free, walkable map-edge tile. */
function spawnTile(state: BattleState, want: Point, taken: Point[]): Point {
  const free = (p: Point) => {
    const t = tileAt(state.map, p);
    return isPassable(t) && !occupant(state, p) && !taken.some((q) => samePoint(p, q));
  };
  if (free(want)) return want;
  const { width: w, height: h } = state.map;
  const edge: Point[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge.push({ x, y });
  const best = edge.filter(free).sort((a, b) => manhattan(a, want) - manhattan(b, want) || a.y - b.y || a.x - b.x)[0];
  if (!best) throw new Error(`no free edge tile for a spawn near ${want.x},${want.y}`);
  return best;
}

/** Tiles a spawn twist will use if it fired now (for the announce marks). */
export function twistTiles(state: BattleState, t: BattleState['twists'][number]): Point[] {
  const taken: Point[] = [];
  for (const s of t.units) taken.push(spawnTile(state, s.pos, taken));
  return taken;
}

/** Runs at the start of every turn, after the turn number advances. */
function runTwists(state: BattleState): void {
  for (const t of state.twists) {
    const n = state.turnNumber;
    if (!t.announced && n >= t.def.firesAtTurn - t.def.announceTurnsAhead && n < t.def.firesAtTurn) {
      t.announced = true;
      emit(state, { type: 'twistAnnounce', twistId: t.def.id, firesAtTurn: t.def.firesAtTurn, tiles: twistTiles(state, t) });
    }
    if (t.fired || n < t.def.firesAtTurn) continue;
    t.fired = true;
    t.announced = true;
    const tiles = twistTiles(state, t);
    const spawned = t.units.map((s, i) => {
      const u = makeUnit({ ...s, pos: tiles[i]! }, state.units.length);
      state.units.push(u);
      return u.id;
    });
    emit(state, { type: 'twist', twistId: t.def.id, spawned });
  }
}

// ---------- traits (job system §9.4) ----------

function turnStartTraits(state: BattleState, u: Unit): void {
  // Hedge Lore: heal 2 at turn start if no foe is adjacent.
  if (hasPassive(u, 'hedgeLore') && u.hp < u.base.hp) {
    const foeAdjacent = state.units.some((e) => e.team !== u.team && e.status === 'ok' && manhattan(e.pos, u.pos) === 1);
    if (!foeAdjacent) {
      const heal = Math.min(2, u.base.hp - u.hp);
      u.hp += heal;
      emit(state, { type: 'trait', unitId: u.id, traitId: 'hedgeLore', heal });
    }
  }
}

// ---------- Yield and escapes (slice spec §4-5) ----------

/** Edge tiles a unit leaves by: civilians use their escape edge, yielding foes any edge. */
export function escapeTiles(state: BattleState, u: Unit): Point[] {
  const { width: w, height: h } = state.map;
  const out: Point[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = u.civilian && u.escapeEdge
        ? (u.escapeEdge === 'N' && y === 0) || (u.escapeEdge === 'S' && y === h - 1) || (u.escapeEdge === 'W' && x === 0) || (u.escapeEdge === 'E' && x === w - 1)
        : x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (edge && isPassable(tileAt(state.map, { x, y }))) out.push({ x, y });
    }
  }
  return out;
}

const onEscapeEdge = (state: BattleState, u: Unit) => escapeTiles(state, u).some((p) => samePoint(p, u.pos));

function flee(state: BattleState, u: Unit): void {
  u.status = 'lost';
  u.fled = true;
  emit(state, { type: 'fled', unitId: u.id, civilian: u.civilian });
  if (u.yielding) {
    changeMorale(state, u.team, SLICE.yield.moraleOnFlee, 'foe fled');
    onSpared(state, u);
  }
  checkWinner(state);
}

/** Damage-over-time ticks at turn start. Returns false if the unit went down. */
function tickDots(state: BattleState, u: Unit): boolean {
  for (const m of u.modifiers.filter((x) => x.dot)) {
    const dot = m.dot!;
    const damage = Math.min(u.hp, dot.damage);
    u.hp -= damage;
    dot.left -= 1;
    emit(state, { type: 'dot', unitId: u.id, damage, hpAfter: u.hp });
    // An Ember tick is the caster's damage: on a yielding foe it breaks the caster's Mercy (slice test M1).
    const caster = state.units.find((x) => x.id === dot.by);
    if (caster && damage > 0) onStrike(state, caster, [{ unitId: u.id, damage }]);
    if (dot.left <= 0) u.modifiers = u.modifiers.filter((x) => x !== m);
    if (u.hp === 0) {
      const by = state.units.find((x) => x.id === dot.by) ?? null;
      u.modifiers = u.modifiers.filter((x) => !x.dot);
      downUnit(state, u, by);
      return false;
    }
  }
  return true;
}
