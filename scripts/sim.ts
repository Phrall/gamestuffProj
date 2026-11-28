// Balance sim: AI vs AI on Mill Ford over many seeds.
// Usage: npm run sim -- --runs 100 --squad scripted|enemy [--traits maren:hardToKill,calla:hedgeLore]
declare const process: { argv: string[]; env: Record<string, string | undefined> };
import { millFordSetup } from '../src/data';
import { planTurn } from '../src/core/ai';
import { createBattle, endTurn, moveUnit, startNextTurn, useAbility, type BattleState } from '../src/core/battle';
import { newSquadMemory, planSquadTurn } from '../src/core/squadAi';
import { swearVow } from '../src/core/vows';
import { battleClassXp } from '../src/core/jobs';

export interface SimSummary {
  runs: number;
  squadWins: number;
  avgTurns: number;
  vows: Record<string, Record<string, number>>;
  /** Vow outcomes split by battle result. */
  vowsByResult: Record<'won' | 'lost', Record<string, Record<string, number>>>;
  abilities: Record<string, number>;
  /** Class XP per battle for each player unit (slice spec §9.1): mean and 10th percentile. */
  classXp: Record<string, { mean: number; p10: number }>;
  /** Trait triggers by unit and trait id (job system §9.4). */
  traits: Record<string, number>;
}

/** Trait slots by unit id, e.g. { maren: ['hardToKill'] }. */
export type SimTraits = Record<string, string[]>;

export function parseTraits(arg: string): SimTraits {
  const out: SimTraits = {};
  for (const part of arg.split(',').filter(Boolean)) {
    const [id, trait] = part.split(':');
    if (!id || !trait) throw new Error(`bad --traits entry "${part}" (want unit:trait)`);
    (out[id] ??= []).push(trait);
  }
  return out;
}

export function runOne(seed: number, squad: 'scripted' | 'enemy', traits: SimTraits = {}): BattleState {
  const setup = millFordSetup();
  for (const u of setup.units) if (traits[u.id]) u.traits = [...traits[u.id]!];
  const s = createBattle(setup, seed);
  const mem = newSquadMemory(s);
  if (squad === 'scripted') {
    swearVow(s, 'maren', 'bulwark');
    swearVow(s, 'tobin', 'loneBlade');
  }
  for (let guard = 0; !s.winner && guard < 1000; guard++) {
    const u = startNextTurn(s);
    if (!u) break;
    const plan = u.team === 'player' && squad === 'scripted' ? planSquadTurn(s, u, mem) : planTurn(s, u);
    moveUnit(s, u.id, plan.moveTo);
    if (plan.action) useAbility(s, u.id, plan.action.abilityId, plan.action.target);
    endTurn(s, plan.facing);
  }
  return s;
}

export function simulate(runs: number, squad: 'scripted' | 'enemy', traits: SimTraits = {}): SimSummary {
  const out: SimSummary = { runs, squadWins: 0, avgTurns: 0, vows: {}, vowsByResult: { won: {}, lost: {} }, abilities: {}, classXp: {}, traits: {} };
  const xp: Record<string, number[]> = {};
  for (let seed = 1; seed <= runs; seed++) {
    const s = runOne(seed, squad, traits);
    for (const u of s.units) if (u.team === 'player') (xp[u.id] ??= []).push(battleClassXp(s, u.id).total);
    if (s.winner === 'player') out.squadWins++;
    out.avgTurns += s.turnNumber / runs;
    for (const [id, v] of Object.entries(s.vows)) {
      const k = `${id}:${v.vowId}`;
      out.vows[k] ??= {};
      out.vows[k]![v.status] = (out.vows[k]![v.status] ?? 0) + 1;
      const r = out.vowsByResult[s.winner === 'player' ? 'won' : 'lost'];
      r[k] ??= {};
      r[k]![v.status] = (r[k]![v.status] ?? 0) + 1;
    }
    for (const e of s.events) {
      if (e.type === 'ability' && s.units.find((u) => u.id === e.unitId)?.team === 'player') out.abilities[e.abilityId] = (out.abilities[e.abilityId] ?? 0) + 1;
      if (e.type === 'trait') out.traits[`${e.unitId}:${e.traitId}`] = (out.traits[`${e.unitId}:${e.traitId}`] ?? 0) + 1;
    }
  }
  out.avgTurns = Math.round(out.avgTurns * 10) / 10;
  for (const [id, xs] of Object.entries(xp)) {
    const sorted = [...xs].sort((a, b) => a - b);
    out.classXp[id] = { mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, p10: sorted[Math.floor(sorted.length * 0.1)]! };
  }
  return out;
}

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1]! : def; };
if (argv.length || process.env.SIM_MAIN) {
  console.log(JSON.stringify(simulate(Number(arg('runs', '100')), arg('squad', 'scripted') as 'scripted' | 'enemy', parseTraits(arg('traits', ''))), null, 2));
}
