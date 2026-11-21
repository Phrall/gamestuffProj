import { describe, expect, it } from 'vitest';
import { millFordSetup } from '../src/data';
import { createBattle, endTurn, getUnit, moveUnit, startNextTurn, useAbility } from '../src/core/battle';
import { planTurn } from '../src/core/ai';
import { previewAction } from '../src/core/combat';
import { battle, flatRows, unit } from './helpers';

function runAi(seed: number, maxTurns = 400) {
  const s = createBattle(millFordSetup(), seed);
  let turns = 0;
  while (!s.winner && turns < maxTurns) {
    const u = startNextTurn(s);
    if (!u) break;
    const plan = planTurn(s, u);
    moveUnit(s, u.id, plan.moveTo);
    if (plan.action) useAbility(s, u.id, plan.action.abilityId, plan.action.target);
    endTurn(s, plan.facing);
    turns++;
  }
  return { s, turns };
}

describe('battle flow', () => {
  it('AI vs AI on Mill Ford always finishes', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { s } = runAi(seed);
      expect(s.winner, `seed ${seed}`).not.toBeNull();
    }
  });

  it('is deterministic for a seed', () => {
    const a = runAi(7).s.events;
    const b = runAi(7).s.events;
    expect(a).toEqual(b);
  });

  it('actual damage matches the preview on a hit', () => {
    const { s } = runAi(3);
    for (const e of s.events) {
      if (e.type !== 'ability') continue;
      for (const r of e.results) {
        const p = e.preview.victims.find((v) => v.unitId === r.unitId)!;
        if (r.hit) expect(r.damage).toBe(p.damage);
        else expect(r.damage).toBe(0);
      }
    }
  });

  it('can only act once and cannot move after acting', () => {
    const s = battle(flatRows(4, 1), [unit('a', 'player', 'sellsword', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 1, 0, 'W', { stats: { hp: 99, atk: 1, mag: 1, def: 0, res: 0, spd: 1, move: 4, jump: 2, eva: 0 } })]);
    startNextTurn(s);
    useAbility(s, 'a', 'strike', { x: 1, y: 0 });
    expect(() => useAbility(s, 'a', 'strike', { x: 1, y: 0 })).toThrow();
    expect(() => moveUnit(s, 'a', { x: 0, y: 0 })).toThrow(); // no move after acting
  });

  it('downed units tick their revive counter, then are lost; Mend revives', () => {
    const s = battle(flatRows(5, 1), [
      unit('mg', 'player', 'hedgeMage', 0, 0, 'E'),
      unit('d', 'player', 'sellsword', 1, 0),
      unit('e', 'enemy', 'sellsword', 4, 0, 'W', { stats: { hp: 99, atk: 1, mag: 1, def: 0, res: 0, spd: 1, move: 0, jump: 0, eva: 0 } }),
    ]);
    const d = getUnit(s, 'd');
    d.hp = 0;
    d.status = 'downed';
    startNextTurn(s);
    const p = previewAction(s, getUnit(s, 'mg'), 'mend', { x: 1, y: 0 }).victims[0]!;
    expect(p.revives).toBe(true);
    expect(p.heal).toBe(8);
    useAbility(s, 'mg', 'mend', { x: 1, y: 0 });
    expect(d.status).toBe('ok');
    expect(d.hp).toBe(8);
  });

  it('morale: downing a foe +5 for you, -10 for them; leader -30 more', () => {
    const s = battle(flatRows(4, 1), [unit('a', 'player', 'sellsword', 0, 0, 'E', { stats: { hp: 30, atk: 99, mag: 0, def: 0, res: 0, spd: 9, move: 4, jump: 2, eva: 0 } }), unit('c', 'enemy', 'sellsword', 1, 0, 'S', { leader: true }), unit('x', 'enemy', 'sellsword', 3, 0)]);
    startNextTurn(s);
    s.rngState = 0;
    let tries = 0;
    while (getUnit(s, 'c').status === 'ok' && tries++ < 20) {
      s.acted = false;
      useAbility(s, 'a', 'strike', { x: 1, y: 0 });
    }
    expect(s.morale.player).toBe(55);
    expect(s.morale.enemy).toBe(10);
  });

  it('a defeated enemy leaves the board and frees its tile (§8, #20)', () => {
    const s = battle(flatRows(4, 1), [unit('a', 'player', 'sellsword', 0, 0, 'E', { stats: { hp: 30, atk: 99, mag: 0, def: 0, res: 0, spd: 9, move: 4, jump: 2, eva: 0 } }), unit('c', 'enemy', 'sellsword', 1, 0, 'W'), unit('x', 'enemy', 'sellsword', 3, 0)]);
    startNextTurn(s);
    s.rngState = 0;
    let tries = 0;
    while (getUnit(s, 'c').status === 'ok' && tries++ < 20) {
      s.acted = false;
      useAbility(s, 'a', 'strike', { x: 1, y: 0 });
    }
    expect(getUnit(s, 'c').status).toBe('lost');
    expect(s.events.some((e) => e.type === 'downed' && e.unitId === 'c')).toBe(true);
    expect(s.events.some((e) => e.type === 'lost' && e.unitId === 'c')).toBe(true);
    expect(getUnit(s, 'a').defeats).toBe(1);
  });

  it('battle is lost when every player unit is downed (§13.6)', () => {
    const s = battle(flatRows(3, 1), [unit('a', 'player', 'sellsword', 0, 0), unit('e', 'enemy', 'sellsword', 2, 0)]);
    getUnit(s, 'a').status = 'downed';
    expect(startNextTurn(s)).toBeNull();
    expect(s.winner).toBe('enemy');
  });
});

describe('enemy AI (§11)', () => {
  it('takes a kill over a bigger hit elsewhere', () => {
    const s = battle(flatRows(5, 3), [
      unit('weak', 'player', 'hedgeMage', 1, 1, 'S'),
      unit('tank', 'player', 'sellsword', 3, 1, 'S'),
      unit('e', 'enemy', 'sellsword', 2, 1, 'S', { abilities: ['strike'] }),
    ]);
    getUnit(s, 'weak').hp = 3;
    const plan = planTurn(s, getUnit(s, 'e'));
    expect(plan.action?.target).toEqual({ x: 1, y: 1 });
  });

  it('Captain holds until a player is within 6 tiles', () => {
    const s = createBattle(millFordSetup());
    const plan = planTurn(s, getUnit(s, 'captain'));
    expect(plan.reason).toBe('holding');
    expect(plan.moveTo).toEqual(getUnit(s, 'captain').pos);
  });

  it('Oath-Binder mends a hurt ally', () => {
    const s = createBattle(millFordSetup());
    getUnit(s, 'spearA').hp = 5;
    const plan = planTurn(s, getUnit(s, 'binder'));
    expect(plan.action?.abilityId).toBe('binderMend');
  });

  it('advances toward the squad when nothing is in reach', () => {
    const s = createBattle(millFordSetup());
    const spear = getUnit(s, 'spearB');
    const plan = planTurn(s, spear);
    expect(plan.action).toBeNull();
    expect(plan.moveTo.y).toBeGreaterThan(spear.pos.y);
  });
});
