// Balance sim: AI vs AI over many seeds, on Mill Ford or a slice battle.
// Usage: npm run sim -- --runs 100 --squad scripted|enemy [--traits maren:hardToKill,calla:hedgeLore]
//        [--battle millFord|ashfordGreen|saltmarshChapel] [--squadLevel n]
declare const process: { argv: string[]; env: Record<string, string | undefined> };
import { millFordSetup, sliceSetup, type SliceBattleId } from '../src/data';
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
  /** Slice battles: per-battle averages of villagers escaped, foes yielded and foes fled; the twist's fire turn. */
  slice: { escaped: number; yielded: number; fled: number; twistFired: number; twistTurnAvg: number };
}

export type SimBattle = 'millFord' | SliceBattleId;
export interface SimOptions { traits?: SimTraits; battle?: SimBattle; squadLevel?: number }

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

export function runOne(seed: number, squad: 'scripted' | 'enemy', opts: SimOptions = {}): BattleState {
  const battle = opts.battle ?? 'millFord';
  const setup = battle === 'millFord' ? millFordSetup() : sliceSetup(battle, { squadLevel: opts.squadLevel });
  for (const u of setup.units) if (opts.traits?.[u.id]) u.traits = [...opts.traits[u.id]!];
  const s = createBattle(setup, seed);
  const mem = newSquadMemory(s, { millFord: battle === 'millFord' });
  if (squad === 'scripted') {
    swearVow(s, 'maren', 'bulwark');
    swearVow(s, 'tobin', 'loneBlade');
    // Slice §8: Calla swears Mercy in battle 3.
    if (battle === 'saltmarshChapel') swearVow(s, 'calla', 'mercy');
  }
  for (let guard = 0; !s.winner && guard < 1000; guard++) {
    const u = startNextTurn(s);
    if (!u) break;
    const plan = u.team === 'player' && squad === 'scripted' && !u.civilian ? planSquadTurn(s, u, mem) : planTurn(s, u);
    moveUnit(s, u.id, plan.moveTo);
    if (plan.action) useAbility(s, u.id, plan.action.abilityId, plan.action.target);
    endTurn(s, plan.facing);
  }
  return s;
}

export function simulate(runs: number, squad: 'scripted' | 'enemy', opts: SimOptions = {}): SimSummary {
  const out: SimSummary = { runs, squadWins: 0, avgTurns: 0, vows: {}, vowsByResult: { won: {}, lost: {} }, abilities: {}, classXp: {}, traits: {}, slice: { escaped: 0, yielded: 0, fled: 0, twistFired: 0, twistTurnAvg: 0 } };
  const xp: Record<string, number[]> = {};
  let twistTurns = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const s = runOne(seed, squad, opts);
    for (const u of s.units) if (u.team === 'player' && !u.civilian) (xp[u.id] ??= []).push(battleClassXp(s, u.id).total);
    let turn = 0;
    for (const e of s.events) {
      if (e.type === 'turnStart') turn++;
      if (e.type === 'fled' && e.civilian) out.slice.escaped += 1 / runs;
      if (e.type === 'fled' && !e.civilian) out.slice.fled += 1 / runs;
      if (e.type === 'yield') out.slice.yielded += 1 / runs;
      if (e.type === 'twist') { out.slice.twistFired++; twistTurns += turn + 1; } // it fires just before its turn's turnStart
    }
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
  const r2 = (n: number) => Math.round(n * 100) / 100;
  out.slice = { escaped: r2(out.slice.escaped), yielded: r2(out.slice.yielded), fled: r2(out.slice.fled), twistFired: out.slice.twistFired, twistTurnAvg: out.slice.twistFired ? r2(twistTurns / out.slice.twistFired) : 0 };
  for (const [id, xs] of Object.entries(xp)) {
    const sorted = [...xs].sort((a, b) => a - b);
    out.classXp[id] = { mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, p10: sorted[Math.floor(sorted.length * 0.1)]! };
  }
  return out;
}

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1]! : def; };
if (argv.length || process.env.SIM_MAIN) {
  console.log(JSON.stringify(simulate(Number(arg('runs', '100')), arg('squad', 'scripted') as 'scripted' | 'enemy', { traits: parseTraits(arg('traits', '')), battle: arg('battle', 'millFord') as SimBattle, squadLevel: argv.includes('--squadLevel') ? Number(arg('squadLevel', '0')) : undefined }), null, 2));
}
