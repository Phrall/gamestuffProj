// Player-facing text, owned by Writing (src/data/strings/*.json; generator in project files).
// Lookups are dotted paths, e.g. t('ui.vows.bulwark.summary', { goal: 1, breakRadius: 3 }).
import en from './strings/millford.en.json';

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
