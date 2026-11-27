// Job system (slice spec §9): class XP from a battle, ranks and the trait rule.
// Pure functions over the battle log, so the sim and the camp screen use the same numbers.
import JOBS from '../data/job-system.json';
import type { BattleState } from './battle';

export const JOB_DATA = JOBS;
const XP = JOBS.classXp;
const SUPPORT = new Set<string>(XP.supportAbilities);
const THRESHOLDS = Object.entries(JOBS.rankThresholds).map(([r, xp]) => [Number(r), xp] as const).sort((a, b) => a[0] - b[0]);

export interface ClassXpBreakdown { deployed: number; actions: number; support: number; defeats: number; intercepts: number; total: number }

/** Class XP a unit earned in one battle (§9.1). Deployed units always get the participation share, even if lost. */
export function battleClassXp(state: BattleState, unitId: string): ClassXpBreakdown {
  const b: ClassXpBreakdown = { deployed: 0, actions: 0, support: 0, defeats: 0, intercepts: 0, total: 0 };
  if (!state.units.some((u) => u.id === unitId)) return b;
  b.deployed = XP.perBattleDeployed;
  const team = state.units.find((u) => u.id === unitId)!.team;
  const teamOf = (id: string) => state.units.find((u) => u.id === id)?.team;
  for (const e of state.events) {
    if (e.type === 'ability' && e.unitId === unitId) {
      b.actions += XP.perAction;
      if (SUPPORT.has(e.abilityId)) b.support += XP.perSupportActionBonus;
    } else if (e.type === 'downed' && e.by === unitId && teamOf(e.unitId) !== team) {
      b.defeats += XP.perDefeat;
    } else if (e.type === 'intercept' && e.unitId === unitId) {
      b.intercepts += XP.perIntercept;
    }
  }
  b.total = b.deployed + b.actions + b.support + b.defeats + b.intercepts;
  return b;
}

/** Rank for a class XP total (§9.2), capped at the chapter cap. */
export function rankFor(xp: number, cap: number = XP.chapterCap.act1.rank): number {
  let rank = 1;
  for (const [r, need] of THRESHOLDS) if (xp >= need) rank = r;
  return Math.min(rank, cap);
}

type ClassEntry = { ranks: Record<string, string[]>; passive: string };
const CLASS_JOBS = JOBS.classes as Record<string, ClassEntry>;

/** Abilities learned in a class at a rank (fixed order, §9.2). Mastery placeholders are left out. */
export function abilitiesAtRank(classId: string, rank: number): string[] {
  const c = CLASS_JOBS[classId];
  if (!c) return [];
  return Object.entries(c.ranks).filter(([r]) => Number(r) <= rank).flatMap(([, ids]) => ids).filter((id) => !id.startsWith('mastery:'));
}

/** Traits a unit may slot (§9.4): the passive of any class at rank 3+, other than the current primary. */
export function eligibleTraits(classXp: Record<string, number>, primary: string): string[] {
  const out: string[] = [];
  for (const [cls, xp] of Object.entries(classXp)) {
    const c = CLASS_JOBS[cls];
    if (c && cls !== primary && rankFor(xp) >= 3) out.push(c.passive);
  }
  return out;
}

type Unlock = { resolve?: { vow: string; min: number }; shadow?: { vow: string; min: number }; anyOf: { class: string; rank: number }[]; inSlice?: boolean };
const UNLOCKS = Object.fromEntries(Object.entries(JOBS.unlocks).filter(([, v]) => !Array.isArray(v))) as Record<string, Unlock>;

/**
 * Classes a unit has unlocked (§9.3): enough Resolve (oath) or Shadow (shadow) on the vow path,
 * and rank 2 in a fitting base class. Classes flagged inSlice: false are left out unless `all` is set.
 */
export function unlockedClasses(p: { resolve: Record<string, number>; shadow: Record<string, number>; classXp: Record<string, number> }, all = false): string[] {
  return Object.entries(UNLOCKS).filter(([, u]) => {
    if (!all && u.inSlice === false) return false;
    const gate = u.resolve ? (p.resolve[u.resolve.vow] ?? 0) >= u.resolve.min : u.shadow ? (p.shadow[u.shadow.vow] ?? 0) >= u.shadow.min : false;
    return gate && u.anyOf.some((c) => rankFor(p.classXp[c.class] ?? 0) >= c.rank);
  }).map(([id]) => id);
}
