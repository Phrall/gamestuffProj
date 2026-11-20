import { describe, expect, it } from 'vitest';
import { endTurn, getUnit, startNextTurn, useAbility } from '../src/core/battle';
import { previewAction } from '../src/core/combat';
import { effectiveStats } from '../src/core/stats';
import { reckonVows, swearVow } from '../src/core/vows';
import { battle, flatRows, unit } from './helpers';

const STRONG = { hp: 99, atk: 40, mag: 0, def: 0, res: 0, spd: 20, move: 4, jump: 2, eva: 0 };
const DUMMY = { hp: 30, atk: 1, mag: 0, def: 0, res: 0, spd: 1, move: 0, jump: 0, eva: 0 };

describe('Bulwark (§9)', () => {
  it('Guard redirects a single-target attack on an adjacent ally, as a front hit', () => {
    const s = battle(flatRows(5, 3), [
      unit('maren', 'player', 'sellsword', 1, 1, 'S'),
      unit('calla', 'player', 'hedgeMage', 2, 1, 'N'),
      unit('e', 'enemy', 'sellsword', 2, 2, 'N', { stats: { ...STRONG, atk: 8 } }),
    ]);
    swearVow(s, 'maren', 'bulwark');
    const p = previewAction(s, getUnit(s, 'e'), 'strike', { x: 2, y: 1 });
    expect(p.interceptedBy).toBe('maren');
    expect(p.victims).toHaveLength(1);
    expect(p.victims[0]!.unitId).toBe('maren');
    expect(p.victims[0]!.side).toBe('front'); // Maren faces S, attacker is SE: would be side
  });

  it('area attacks are not intercepted; ranged ones are (§13.4)', () => {
    const s = battle(flatRows(7, 3), [
      unit('maren', 'player', 'sellsword', 1, 1),
      unit('calla', 'player', 'hedgeMage', 2, 1),
      unit('bow', 'enemy', 'bowhand', 6, 1, 'W'),
    ]);
    swearVow(s, 'maren', 'bulwark');
    const bow = getUnit(s, 'bow');
    expect(previewAction(s, bow, 'shoot', { x: 2, y: 1 }).interceptedBy).toBe('maren');
    expect(previewAction(s, bow, 'volley', { x: 2, y: 1 }).interceptedBy).toBeUndefined();
  });

  it('3 intercepts fulfil it (+10 morale); Guard keeps working after', () => {
    const s = battle(flatRows(5, 3), [
      unit('maren', 'player', 'sellsword', 1, 1, 'E', { stats: { ...DUMMY, hp: 200, spd: 1 } }),
      unit('calla', 'player', 'hedgeMage', 2, 1, 'N', { stats: { ...DUMMY, spd: 1 } }),
      unit('e', 'enemy', 'hedgeMage', 2, 2, 'N', { stats: { ...STRONG, mag: 1 } }),
    ]);
    swearVow(s, 'maren', 'bulwark');
    for (let i = 0; i < 4; i++) {
      startNextTurn(s);
      useAbility(s, 'e', 'spark', { x: 2, y: 1 });
      endTurn(s);
    }
    expect(s.vows.maren!.status).toBe('fulfilled');
    expect(s.vows.maren!.progress).toBe(3);
    expect(getUnit(s, 'calla').hp).toBe(getUnit(s, 'calla').base.hp);
    expect(s.morale.player).toBe(60);
  });

  it('breaks when an ally within 2 tiles is downed: surge +3 Atk +1 Move, Guard ends', () => {
    const s = battle(flatRows(6, 3), [
      unit('maren', 'player', 'sellsword', 0, 1),
      unit('wren', 'player', 'bowhand', 2, 1, 'N', { stats: { ...DUMMY, hp: 1 } }),
      unit('e', 'enemy', 'hedgeMage', 5, 1, 'W', { stats: STRONG }),
    ]);
    swearVow(s, 'maren', 'bulwark');
    startNextTurn(s);
    useAbility(s, 'e', 'spark', { x: 2, y: 1 });
    expect(s.vows.maren!.status).toBe('broken');
    const st = effectiveStats(s, getUnit(s, 'maren'));
    expect(st.atk).toBe(8 + 3);
    expect(st.move).toBe(4 + 1);
    expect(s.morale.player).toBe(50 - 10 - 15);
    expect(reckonVows(s)[0]).toMatchObject({ status: 'broken', shadow: 2, resolve: 0 });
  });
});

describe('Lone Blade (§9)', () => {
  it('+1 Atk only with no ally adjacent', () => {
    const s = battle(flatRows(5, 3), [
      unit('tobin', 'player', 'sellsword', 1, 1, 'E'),
      unit('e', 'enemy', 'sellsword', 2, 1, 'W', { stats: DUMMY }),
      unit('ally', 'player', 'sellsword', 4, 2),
    ]);
    swearVow(s, 'tobin', 'loneBlade');
    const tobin = getUnit(s, 'tobin');
    expect(previewAction(s, tobin, 'strike', { x: 2, y: 1 }).victims[0]!.damage).toBe(5 + 8 + 1);
    getUnit(s, 'ally').pos = { x: 1, y: 2 };
    expect(previewAction(s, tobin, 'strike', { x: 2, y: 1 }).victims[0]!.damage).toBe(5 + 8);
  });

  it('a defeat with an ally adjacent breaks it, and the preview warns first', () => {
    const s = battle(flatRows(5, 3), [
      unit('tobin', 'player', 'sellsword', 1, 1, 'E', { stats: { ...STRONG } }),
      unit('e', 'enemy', 'sellsword', 2, 1, 'W', { stats: DUMMY }),
      unit('ally', 'player', 'sellsword', 1, 2),
    ]);
    swearVow(s, 'tobin', 'loneBlade');
    startNextTurn(s);
    expect(previewAction(s, getUnit(s, 'tobin'), 'strike', { x: 2, y: 1 }).breaksVow).toBe(true);
    s.rngState = 3;
    for (let i = 0; i < 10 && getUnit(s, 'e').status === 'ok'; i++) { s.acted = false; useAbility(s, 'tobin', 'strike', { x: 2, y: 1 }); }
    expect(s.vows.tobin!.status).toBe('broken');
    expect(effectiveStats(s, getUnit(s, 'tobin')).hit).toBe(10);
  });

  it('2 solo defeats fulfil it', () => {
    const s = battle(flatRows(5, 3), [
      unit('tobin', 'player', 'sellsword', 1, 1, 'E', { stats: { ...STRONG } }),
      unit('e1', 'enemy', 'sellsword', 2, 1, 'W', { stats: DUMMY }),
      unit('e2', 'enemy', 'sellsword', 0, 1, 'E', { stats: DUMMY }),
      unit('e3', 'enemy', 'sellsword', 4, 2, 'E', { stats: DUMMY }),
    ]);
    swearVow(s, 'tobin', 'loneBlade');
    startNextTurn(s);
    for (const t of [{ x: 2, y: 1 }, { x: 0, y: 1 }]) {
      const id = t.x === 2 ? 'e1' : 'e2';
      for (let i = 0; i < 10 && getUnit(s, id).status === 'ok'; i++) { s.acted = false; useAbility(s, 'tobin', 'strike', t); }
    }
    expect(s.vows.tobin!.status).toBe('fulfilled');
  });
});

describe('vow resolution (§13.3)', () => {
  it('downed while intact freezes, then lapses at battle end', () => {
    const s = battle(flatRows(5, 1), [
      unit('tobin', 'player', 'sellsword', 0, 0, 'E', { stats: { ...DUMMY, hp: 1 } }),
      unit('p2', 'player', 'sellsword', 4, 0, 'E', { stats: { ...DUMMY, hp: 1 } }),
      unit('e', 'enemy', 'hedgeMage', 2, 0, 'W', { stats: STRONG }),
    ]);
    swearVow(s, 'tobin', 'loneBlade');
    startNextTurn(s);
    useAbility(s, 'e', 'spark', { x: 0, y: 0 });
    expect(s.vows.tobin!.frozen).toBe(true);
    useAbility((s.acted = false, s), 'e', 'spark', { x: 4, y: 0 });
    expect(s.winner).toBe('enemy');
    expect(s.vows.tobin!.status).toBe('lapsed');
  });
});

describe('scripted squad sim', () => {
  it('finishes every seed and is deterministic', async () => {
    const { runOne } = await import('../scripts/sim');
    for (let seed = 1; seed <= 10; seed++) expect(runOne(seed, 'scripted').winner).not.toBeNull();
    expect(runOne(5, 'scripted').events).toEqual(runOne(5, 'scripted').events);
  });
});
