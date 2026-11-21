import { describe, expect, it } from 'vitest';
import { endTurn, getUnit, startNextTurn, useAbility } from '../src/core/battle';
import { previewAction } from '../src/core/combat';
import { effectiveStats } from '../src/core/stats';
import { reckonVows, swearVow } from '../src/core/vows';
import { VOWS } from '../src/data';
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

  it('meeting the goal does not keep it early: Kept (+10 morale) only at battle end; Guard keeps working (v1.7)', () => {
    const s = battle(flatRows(5, 3), [
      unit('maren', 'player', 'sellsword', 1, 1, 'E', { stats: { ...DUMMY, hp: 200, spd: 1 } }),
      unit('calla', 'player', 'hedgeMage', 2, 1, 'N', { stats: { ...DUMMY, spd: 1 } }),
      unit('e', 'enemy', 'hedgeMage', 2, 2, 'N', { stats: { ...STRONG, mag: 1 } }),
    ]);
    swearVow(s, 'maren', 'bulwark');
    const goal = VOWS.bulwark.goal;
    for (let i = 0; i < goal + 1; i++) {
      startNextTurn(s);
      useAbility(s, 'e', 'spark', { x: 2, y: 1 });
      endTurn(s);
    }
    expect(s.vows.maren!.status).toBe('intact');
    expect(s.vows.maren!.progress).toBe(goal);
    expect(getUnit(s, 'calla').hp).toBe(getUnit(s, 'calla').base.hp);
    expect(s.morale.player).toBe(50);
    expect(s.events.some((e) => e.type === 'vowFulfilled')).toBe(false);
    // End the battle: the enemy falls.
    getUnit(s, 'e').status = 'lost';
    startNextTurn(s);
    expect(s.winner).toBe('player');
    expect(s.vows.maren!.status).toBe('fulfilled');
    expect(s.events.some((e) => e.type === 'vowFulfilled' && e.unitId === 'maren')).toBe(true);
    expect(s.morale.player).toBe(60);
  });

  it('a frozen Held vow cannot break and is Kept at battle end; a frozen 0/1 lapses (UX ruling 3)', () => {
    const s = battle(flatRows(6, 1), [unit('maren', 'player', 'sellsword', 0, 0), unit('calla', 'player', 'hedgeMage', 1, 0), unit('e', 'enemy', 'sellsword', 5, 0)]);
    swearVow(s, 'maren', 'bulwark');
    s.vows.maren!.progress = 1;
    s.vows.maren!.frozen = true;
    getUnit(s, 'maren').status = 'downed';
    getUnit(s, 'calla').status = 'downed';
    getUnit(s, 'e').status = 'lost';
    startNextTurn(s);
    expect(s.vows.maren!.status).toBe('fulfilled');
    const s2 = battle(flatRows(6, 1), [unit('maren', 'player', 'sellsword', 0, 0), unit('e', 'enemy', 'sellsword', 5, 0)]);
    swearVow(s2, 'maren', 'bulwark');
    s2.vows.maren!.frozen = true;
    getUnit(s2, 'e').status = 'lost';
    startNextTurn(s2);
    expect(s2.vows.maren!.status).toBe('lapsed');
  });

  it('a break after the goal is met still breaks it (v1.7)', () => {
    const s = battle(flatRows(7, 3), [
      unit('maren', 'player', 'sellsword', 1, 1, 'E', { stats: { ...DUMMY, hp: 200, spd: 1 } }),
      unit('calla', 'player', 'hedgeMage', 2, 1, 'N', { stats: { ...DUMMY, spd: 1 } }),
      unit('wren', 'player', 'bowhand', 4, 1, 'N', { stats: { ...DUMMY, hp: 1, spd: 1 } }),
      unit('e', 'enemy', 'hedgeMage', 2, 2, 'N', { stats: { ...STRONG, mag: 1 } }),
    ]);
    swearVow(s, 'maren', 'bulwark');
    startNextTurn(s);
    useAbility(s, 'e', 'spark', { x: 2, y: 1 }); // Guard intercepts: goal met
    expect(s.vows.maren!.progress).toBe(VOWS.bulwark.goal);
    s.acted = false;
    useAbility(s, 'e', 'spark', { x: 4, y: 1 }); // Wren, 3 tiles away (beyond Guard reach), falls
    expect(getUnit(s, 'wren').status).toBe('downed');
    expect(s.vows.maren!.status).toBe('broken');
  });

  it('breaks when an ally beyond Guard reach but within break radius is downed: surge +3 Atk +1 Move, Guard ends', () => {
    // v1.5: Guard covers allies within 2 tiles, so the fallen ally stands 3 away (breakRadius 3).
    const s = battle(flatRows(6, 3), [
      unit('maren', 'player', 'sellsword', 0, 1),
      unit('wren', 'player', 'bowhand', 3, 1, 'N', { stats: { ...DUMMY, hp: 1 } }),
      unit('e', 'enemy', 'hedgeMage', 5, 1, 'W', { stats: STRONG }),
    ]);
    swearVow(s, 'maren', 'bulwark');
    startNextTurn(s);
    useAbility(s, 'e', 'spark', { x: 3, y: 1 });
    expect(s.vows.maren!.status).toBe('broken');
    const st = effectiveStats(s, getUnit(s, 'maren'));
    expect(st.atk).toBe(8 + 3);
    expect(st.move).toBe(4 + 1);
    expect(s.morale.player).toBe(50 - 10 - 15);
    expect(reckonVows(s)[0]).toMatchObject({ status: 'broken', shadow: 2, resolve: 0 });
  });
});

describe('Lone Blade (§9)', () => {
  it('Atk bonus only with no ally adjacent', () => {
    const s = battle(flatRows(5, 3), [
      unit('tobin', 'player', 'sellsword', 1, 1, 'E'),
      unit('e', 'enemy', 'sellsword', 2, 1, 'W', { stats: DUMMY }),
      unit('ally', 'player', 'sellsword', 4, 2),
    ]);
    swearVow(s, 'tobin', 'loneBlade');
    const tobin = getUnit(s, 'tobin');
    expect(previewAction(s, tobin, 'strike', { x: 2, y: 1 }).victims[0]!.damage).toBe(5 + 8 + VOWS.loneBlade.whileSworn.atkWhenAlone);
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

describe('Bulwark Guard reach (v1.5)', () => {
  it('Guard intercepts for an ally up to guardRadius tiles away', () => {
    const s = battle(flatRows(6, 3), [
      unit('maren', 'player', 'sellsword', 0, 1),
      unit('wren', 'player', 'bowhand', 2, 1, 'N'),
      unit('e', 'enemy', 'hedgeMage', 5, 1, 'W'),
    ]);
    swearVow(s, 'maren', 'bulwark');
    expect(previewAction(s, getUnit(s, 'e'), 'spark', { x: 2, y: 1 }).interceptedBy).toBe('maren');
  });
});
