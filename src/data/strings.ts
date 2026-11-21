// Player-facing text, owned by Writing (src/data/strings/*.json; generator in project files).
// Lookups are dotted paths, e.g. t('ui.vows.bulwark.summary', { goal: 1, breakRadius: 3 }).
import en from './strings/millford.en.json';
import { ABILITIES, RULES, VOWS } from './index';


type Tree = { [k: string]: string | string[] | Tree | Tree[] };
const STRINGS = en as unknown as Tree;

/** The raw value at a dotted path (string, array or subtree), or undefined. */
export function lookup(path: string): unknown {
  let cur: unknown = STRINGS;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as object)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** Fill {placeholders}; unknown ones are left as-is so a missing param is visible, not silent. */
export function format(s: string, params: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** A string at a path, formatted. Falls back to the path itself so missing keys show up in play. */
export function t(path: string, params?: Record<string, string | number>): string {
  const v = lookup(path);
  return typeof v === 'string' ? format(v, params) : path;
}

/** One of a bark's lines, picked with the given random function (pass the battle RNG for replays). */
export function bark(unitId: string, kind: string, rand: () => number): string | null {
  const lines = lookup(`barks.${unitId}.${kind}`);
  if (!Array.isArray(lines) || !lines.length) return null;
  return String(lines[Math.floor(rand() * lines.length) % lines.length]);
}

/** Scene lines (pre-battle, post-battle) in order. */
export function scene(id: string): { id: string; speaker: string; text: string }[] {
  const s = (STRINGS.scenes as Record<string, unknown> | undefined)?.[id];
  return Array.isArray(s) ? (s as { id: string; speaker: string; text: string }[]) : [];
}

export const STRINGS_META = { version: String(en.version), dataVersion: String(en.dataVersion) };

// ---------- params from the data file (Writing's _params map) ----------

type Params = Record<string, string | number>;
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** Placeholders for ui.vows.<vowId>.* and ui.reckoning.detail.<vowId>.*. */
export function vowParams(vowId: string, n = 0): Params {
  const v = (VOWS as Record<string, Record<string, unknown>>)[vowId] ?? {};
  const kept = (v.kept ?? {}) as { resolve?: number };
  const broken = (v.broken ?? {}) as { shadow?: number; surge?: { atk?: number; move?: number; hit?: number } };
  const ws = (v.whileSworn ?? {}) as { atkWhenAlone?: number };
  return {
    n, goal: v.goal as number,
    breakRadius: VOWS.bulwark.breakRadius, guardRadius: VOWS.bulwark.guardRadius,
    resolve: kept.resolve ?? 0, shadow: broken.shadow ?? 0,
    oathClass: String(v.oathClass ?? ''), shadowClass: String(v.shadowClass ?? ''),
    morale: RULES.morale.events.vowFulfilled, moraleBroken: signed(RULES.morale.events.vowBroken),
    surgeAtk: broken.surge?.atk ?? 0, surgeMove: broken.surge?.move ?? 0, surgeHit: broken.surge?.hit ?? 0,
    atkWhenAlone: ws.atkWhenAlone ?? 0,
  };
}

/** Placeholders for ui.abilities.<id>.tooltip. `mag` is the caster's Mag, for Mend's heal. */
export function abilityParams(id: string, mag = 0): Params {
  const a = ABILITIES[id] as unknown as Record<string, unknown> | undefined;
  if (!a) return {};
  const range = (a.range as [number, number] | undefined) ?? [0, 0];
  const extra = { ...(a.buff as object), ...(a.debuff as object) } as Record<string, unknown>;
  const out: Params = {
    range: range[0] === range[1] ? String(range[0]) : `${range[0]}-${range[1]}`,
    rangeMax: range[1], cd: (a.cd as number) ?? 0,
    heal: RULES.heal.base + Math.floor(mag / RULES.heal.magDivisor),
  };
  for (const k of ['def', 'res', 'move', 'jump', 'hitBonus', 'push', 'blockedBonus', 'fallMinDrop', 'morale']) {
    const val = (extra[k] ?? a[k]) as number | undefined;
    if (typeof val === 'number') out[k] = id === 'thornsnare' && k === 'move' ? signed(val) : Math.abs(val);
  }
  return out;
}

/** Placeholders for ui.morale.<tier>.tooltip. */
export function moraleParams(tier: string): Params {
  const tt = RULES.morale.tiers.find((x) => x.name.toLowerCase() === tier.toLowerCase());
  return tt ? { hit: signed(tt.hit), move: signed(tt.move), dmgPct: Math.round(tt.dmg * 100) } : {};
}

/** Display names. */
export const unitName = (id: string, fallback = id): string => (lookup(`ui.units.${id}.name`) as string | undefined) ?? fallback;
export const unitShort = (id: string, fallback = id): string => (lookup(`ui.units.${id}.shortName`) as string | undefined) ?? fallback;
export const abilityName = (id: string): string => (lookup(`ui.abilities.${id}.name`) as string | undefined) ?? id;
export const abilityShort = (id: string): string => (lookup(`ui.abilities.${id}.shortName`) as string | undefined) ?? abilityName(id);
export const vowName = (id: string): string => (lookup(`ui.vows.${id}.name`) as string | undefined) ?? id;
