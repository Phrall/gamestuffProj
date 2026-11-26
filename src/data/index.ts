// Typed access to the Game Design data file. Design edits prototype-data.json;
// this file only reshapes it for the engine.
import raw from './prototype-data.json';
import type { AbilityDef, Facing, GridMap, Stats, Tile } from '../core/types';

export type Rules = typeof raw.rules;
export const RULES: Rules = raw.rules;
export const VOWS = raw.vows;

interface RawStats { hp: number; atk: number; mag: number; def: number; res: number; spd: number; move: number; jump: number; eva: number }

// ---------- stats from class, level, attributes and gear (spec §19, v1.6) ----------

export type Attr = 'str' | 'vit' | 'dex' | 'agi' | 'int' | 'wil';
export type Attributes = Record<Attr, number>;
interface StatClass { base: Attributes; growthPerLevel: Attributes; move: number; jump: number; weapon: string; armor: string }
interface Weapon { atk?: number; mag?: number }
interface Armor { def: number; res: number; weight: number }

export const STAT_CLASSES = raw.statClasses as Record<string, StatClass>;
export const WEAPONS = raw.weapons as Record<string, Weapon>;
export const ARMOR = raw.armor as Record<string, Armor>;
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
  Object.entries(raw.abilities).map(([id, a]) => [id, { id, ...(a as Omit<AbilityDef, 'id'>) }]),
);

export interface ClassData { id: string; name: string; stats: Stats; abilities: string[] }

export const CLASSES: Record<string, ClassData> = Object.fromEntries(
  Object.entries(raw.classes).map(([id, c]) => [id, { id, name: c.name, stats: { ...(c.stats as RawStats) }, abilities: c.abilities }]),
);

export function parseMap(m: { id: string; name: string; width: number; height: number; rows: string[] }): GridMap {
  const tiles: Tile[] = [];
  if (m.rows.length !== m.height) throw new Error(`map ${m.id}: expected ${m.height} rows`);
  for (const row of m.rows) {
    const cells = row.trim().split(/\s+/);
    if (cells.length !== m.width) throw new Error(`map ${m.id}: row "${row}" is not ${m.width} wide`);
    for (const c of cells) {
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
}

export interface BattleSetup { map: GridMap; units: UnitSetup[] }

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
