// Typed access to the Game Design data file. Design edits prototype-data.json;
// this file only reshapes it for the engine.
import raw from './prototype-data.json';
import slice from './slice-battles.json';
import type { AbilityDef, Facing, GridMap, Stats, Tile, TwistDef } from '../core/types';

export type Rules = typeof raw.rules;
export const RULES: Rules = raw.rules;
/** Slice battles 2-3 data (Game Design). Its stat classes, gear, abilities and vows extend the prototype's. */
export const SLICE = slice;
export const VOWS = { ...raw.vows, ...slice.vows };

interface RawStats { hp: number; atk: number; mag: number; def: number; res: number; spd: number; move: number; jump: number; eva: number }

// ---------- stats from class, level, attributes and gear (spec §19, v1.6) ----------

export type Attr = 'str' | 'vit' | 'dex' | 'agi' | 'int' | 'wil';
export type Attributes = Record<Attr, number>;
interface StatClass { base: Attributes; growthPerLevel: Attributes; move: number; jump: number; weapon: string; armor: string }
interface Weapon { atk?: number; mag?: number }
interface Armor { def: number; res: number; weight: number }

export const STAT_CLASSES = { ...raw.statClasses, ...slice.statClasses } as Record<string, StatClass>;
export const WEAPONS = { ...raw.weapons, ...slice.weapons } as Record<string, Weapon>;
export const ARMOR = { ...raw.armor, ...slice.armor } as Record<string, Armor>;
const ATTRS = raw.statRules.attributes as Attr[];

/** Attribute at level L = class base + floor(growth × (L − 1)). Growth is fixed, so no random level-ups. */
export function attributesAt(statClass: string, level: number): Attributes {
  const c = STAT_CLASSES[statClass];
  if (!c) throw new Error(`unknown stat class ${statClass}`);
  return Object.fromEntries(ATTRS.map((k) => [k, c.base[k] + Math.floor(c.growthPerLevel[k] * (level - 1))])) as Attributes;
}

/** Combat stats derived from attributes and gear (§19 table). */
export function deriveStats(statClass: string, level: number): Stats {
  const c = STAT_CLASSES[statClass]!;
  const a = attributesAt(statClass, level);
  const w = WEAPONS[c.weapon];
  const ar = ARMOR[c.armor];
  if (!w || !ar) throw new Error(`stat class ${statClass}: unknown gear ${c.weapon}/${c.armor}`);
  return {
    hp: 10 + 2 * a.vit,
    atk: a.str + (w.atk ?? 0),
    mag: a.int + (w.mag ?? 0),
    def: ar.def + Math.floor(a.vit / 5),
    res: ar.res + Math.floor(a.wil / 2),
    spd: 2 + Math.floor(a.agi / 2),
    move: c.move,
    jump: c.jump,
    eva: Math.max(0, a.agi + Math.floor(a.dex / 2) - ar.weight),
    hitBonus: Math.floor(a.dex / 2),
  };
}

/** The raw data file, for tests that check derived stats against Design's written blocks. */
export const RAW_DATA = raw;

export const ABILITIES: Record<string, AbilityDef> = Object.fromEntries(
  Object.entries({ ...raw.abilities, ...slice.abilities }).map(([id, a]) => [id, { id, ...(a as Omit<AbilityDef, 'id'>) }]),
);

export interface ClassData { id: string; name: string; stats: Stats; abilities: string[] }

export const CLASSES: Record<string, ClassData> = Object.fromEntries([
  ...Object.entries(raw.classes).map(([id, c]) => [id, { id, name: c.name, stats: { ...(c.stats as RawStats) }, abilities: c.abilities }]),
  // Slice oath classes: stats derive from the class and level like every unit (§19).
  ...Object.entries(slice.classes).map(([id, c]) => [id, { id, name: c.name, stats: deriveStats(id, c.level), abilities: c.abilities }]),
]);

export interface LegendEntry { kind: Tile['kind']; height: number; terrain?: string }

/** Parse a map. Mill Ford's codes (W water, X boulder, F ford, B bridge) apply unless `codes` gives a map's own legend. */
export function parseMap(m: { id: string; name: string; width: number; height: number; rows: string[]; codes?: Record<string, LegendEntry> }): GridMap {
  const tiles: Tile[] = [];
  if (m.rows.length !== m.height) throw new Error(`map ${m.id}: expected ${m.height} rows`);
  for (const row of m.rows) {
    const cells = row.trim().split(/\s+/);
    if (cells.length !== m.width) throw new Error(`map ${m.id}: row "${row}" is not ${m.width} wide`);
    for (const c of cells) {
      const l = m.codes?.[c];
      if (m.codes) {
        if (l) tiles.push({ kind: l.kind, height: l.height, ...(l.terrain && l.terrain !== l.kind ? { terrain: l.terrain } : {}) });
        else if (Number.isInteger(Number(c))) tiles.push({ kind: 'ground', height: Number(c) });
        else throw new Error(`map ${m.id}: bad cell "${c}"`);
        continue;
      }
      if (c === 'W') tiles.push({ kind: 'water', height: 0 });
      else if (c === 'X') tiles.push({ kind: 'boulder', height: 0 });
      else if (c === 'F') tiles.push({ kind: 'ford', height: 0 });
      else if (c === 'B') tiles.push({ kind: 'ground', height: 1, bridge: true });
      else {
        const h = Number(c);
        if (!Number.isInteger(h)) throw new Error(`map ${m.id}: bad cell "${c}"`);
        tiles.push({ kind: 'ground', height: h });
      }
    }
  }
  return { id: m.id, name: m.name, width: m.width, height: m.height, tiles };
}

export interface UnitSetup {
  id: string;
  name: string;
  team: 'player' | 'enemy';
  classId: string | null;
  leader: boolean;
  stats: Stats;
  abilities: string[];
  pos: { x: number; y: number };
  facing: Facing;
  ai?: { holdUntilWithin?: number; prefersHeight?: number; healBelow?: number };
  suggestedVow?: 'bulwark' | 'loneBlade' | null;
  /** Trait slot (job system §9.4). */
  traits?: string[];
  yieldBelow?: number;
  civilian?: boolean;
  escapeEdge?: Facing;
  prefers?: ('civilian' | 'backLine')[];
}

/** A spawn twist carries the units it brings in. */
export interface TwistSetup extends TwistDef { units: UnitSetup[] }

export interface BattleSetup { map: GridMap; units: UnitSetup[]; twists?: TwistSetup[] }

export function millFordSetup(): BattleSetup {
  const units: UnitSetup[] = [];
  for (const p of raw.playerUnits) {
    const cls = CLASSES[p.class];
    if (!cls) throw new Error(`unknown class ${p.class}`);
    units.push({
      id: p.id, name: p.name, team: 'player', classId: p.class, leader: false,
      // §19: stats come from class + level + attributes + gear, derived at battle start.
      stats: deriveStats(p.class, p.level), abilities: [...cls.abilities],
      pos: { x: p.pos[0]!, y: p.pos[1]! }, facing: p.facing as Facing,
      suggestedVow: (p.suggestedVow ?? null) as UnitSetup['suggestedVow'],
    });
  }
  for (const e of raw.enemyUnits) {
    const ex = e as typeof e & { leader?: boolean; holdUntilWithin?: number; prefersHeight?: number; healBelow?: number };
    units.push({
      id: e.id, name: e.name, team: 'enemy', classId: null, leader: !!ex.leader,
      stats: deriveStats(e.statClass, e.level), abilities: [...e.abilities],
      pos: { x: e.pos[0]!, y: e.pos[1]! }, facing: e.facing as Facing,
      ai: { holdUntilWithin: ex.holdUntilWithin, prefersHeight: ex.prefersHeight, healBelow: ex.healBelow },
    });
  }
  return { map: parseMap(raw.map), units };
}

// ---------- slice battles 2-3 (vertical-slice-spec §5-6) ----------

export type SliceBattleId = keyof typeof slice.battles;
type SliceUnit = { id: string; name: string; statClass: string; level: number; pos: number[]; facing: string; abilities?: string[]; leader?: boolean; yieldBelow?: number; prefers?: string[]; escapeEdge?: string };

function sliceUnit(u: SliceUnit, team: 'player' | 'enemy', civilian = false): UnitSetup {
  return {
    id: u.id, name: u.name, team, classId: null, leader: !!u.leader,
    stats: deriveStats(u.statClass, u.level), abilities: [...(u.abilities ?? [])],
    pos: { x: u.pos[0]!, y: u.pos[1]! }, facing: u.facing as Facing,
    ...(u.yieldBelow !== undefined ? { yieldBelow: u.yieldBelow } : {}),
    ...(u.prefers ? { prefers: u.prefers as UnitSetup['prefers'] } : {}),
    ...(civilian ? { civilian: true, escapeEdge: u.escapeEdge as Facing } : {}),
  };
}

/** Battle 2 or 3 at the spec's squad level. The squad is the Mill Ford four in their prototype classes. */
export function sliceSetup(id: SliceBattleId, opts: { squadLevel?: number } = {}): BattleSetup {
  const b = slice.battles[id] as (typeof slice.battles)[SliceBattleId] & { overrides?: { pos: number[]; terrain: string }[] };
  const map = parseMap({ id, name: b.name, width: b.rows[0]!.split(' ').length, height: b.rows.length, rows: b.rows, codes: b.legend as Record<string, LegendEntry> });
  for (const o of b.overrides ?? []) map.tiles[o.pos[1]! * map.width + o.pos[0]!]!.terrain = o.terrain;
  const level = opts.squadLevel ?? b.squadLevel;
  const units: UnitSetup[] = b.squad.map((s) => {
    const p = raw.playerUnits.find((x) => x.id === s.id)!;
    const cls = CLASSES[p.class]!;
    return {
      id: p.id, name: p.name, team: 'player' as const, classId: p.class, leader: false,
      stats: deriveStats(p.class, level), abilities: [...cls.abilities],
      pos: { x: s.pos[0]!, y: s.pos[1]! }, facing: s.facing as Facing,
    };
  });
  for (const e of b.enemies as SliceUnit[]) units.push(sliceUnit(e, 'enemy'));
  for (const c of b.civilians as SliceUnit[]) units.push(sliceUnit(c, 'player', true));
  const twists = (b.twists as { id: string; firesAtTurn: number; announceTurnsAhead: number; effect: 'spawn'; units: SliceUnit[] }[])
    .map((t) => ({ ...t, units: t.units.map((u) => sliceUnit(u, 'enemy')) }));
  return { map, units, twists };
}
