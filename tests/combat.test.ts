import { describe, expect, it } from 'vitest';
import { millFordSetup } from '../src/data';
import { createBattle, getUnit } from '../src/core/battle';
import { attackSide, previewAction, targetTiles } from '../src/core/combat';
import { battle, flatRows, unit } from './helpers';

const v0 = (s: ReturnType<typeof battle>, actor: string, ability: string, x: number, y: number) =>
  previewAction(s, getUnit(s, actor), ability, { x, y }).victims[0]!;

describe('facing (§4)', () => {
  it('front, side and back relative to the target facing', () => {
    const t = { pos: { x: 5, y: 5 }, facing: 'N' } as Parameters<typeof attackSide>[1];
    expect(attackSide({ x: 5, y: 4 }, t)).toBe('front');
    expect(attackSide({ x: 5, y: 6 }, t)).toBe('back');
    expect(attackSide({ x: 6, y: 5 }, t)).toBe('side');
    expect(attackSide({ x: 7, y: 6 }, t)).toBe('side');
    expect(attackSide({ x: 5, y: 6 }, t, true)).toBe('front');
  });
});

describe('spec sanity checks (§10)', () => {
  const s = createBattle(millFordSetup());
  const spear = getUnit(s, 'spearA');
  const archer = getUnit(s, 'archerA');
  it('Strike on a Spearman = 9, Spark = 10, Shoot on an Archer = 9, Thrust on a Sellsword = 7', () => {
    const flat = battle(flatRows(8, 1), [
      unit('sw', 'player', 'sellsword', 0, 0, 'E'),
      { ...unit('sp', 'enemy', 'sellsword', 1, 0, 'W'), stats: { ...spear.base }, abilities: ['thrust'] },
      unit('mg', 'player', 'hedgeMage', 3, 0, 'W'),
      unit('bw', 'player', 'bowhand', 5, 0, 'E'),
      { ...unit('ar', 'enemy', 'bowhand', 7, 0, 'W'), stats: { ...archer.base }, abilities: ['shoot'] },
    ]);
    expect(v0(flat, 'sw', 'strike', 1, 0).damage).toBe(9);
    expect(v0(flat, 'mg', 'spark', 1, 0).damage).toBe(10);
    expect(v0(flat, 'bw', 'shoot', 7, 0).damage).toBe(9); // v1.9: Archer back to level 3, Def 2 (as v1.7)
    expect(v0(flat, 'sp', 'thrust', 0, 0).damage).toBe(7);
  });
});

describe('hit and damage modifiers (§5, §6)', () => {
  it('back attacks ignore evade and add 30% damage; side halves evade and adds 15%', () => {
    const s = battle(flatRows(3, 3), [unit('a', 'player', 'sellsword', 1, 0), unit('b', 'player', 'sellsword', 0, 1), unit('e', 'enemy', 'sellsword', 1, 1, 'S')]);
    const back = v0(s, 'a', 'strike', 1, 1); // a is north of e, e faces south
    expect(back.side).toBe('back');
    expect(back.hit).toBe(90);
    expect(back.damage).toBe(Math.floor(9 * 1.3)); // 11
    const side = v0(s, 'b', 'strike', 1, 1);
    expect(side.side).toBe('side');
    expect(side.hit).toBe(85);
    expect(side.damage).toBe(Math.floor(9 * 1.15)); // 10
  });

  it('height: +5 hit and +10% damage per level, capped', () => {
    const s = battle(['3 0 0 0 0'], [unit('bw', 'player', 'bowhand', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 3, 0, 'W')]);
    const v = v0(s, 'bw', 'shoot', 3, 0);
    expect(v.heightDiff).toBe(3);
    expect(v.hit).toBe(85 - 10 + 15);
    expect(v.damage).toBe(Math.floor((4 + 7 - 4) * 1.3));
  });

  it('magic always hits; hit is clamped to [10, 95]', () => {
    const s = battle(flatRows(4, 1), [unit('mg', 'player', 'hedgeMage', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 2, 0, 'W', { stats: { hp: 30, atk: 8, mag: 2, def: 4, res: 2, spd: 6, move: 4, jump: 2, eva: 200 } })]);
    expect(v0(s, 'mg', 'spark', 2, 0).hit).toBe(100);
    const s2 = battle(flatRows(4, 1), [unit('bw', 'player', 'bowhand', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 2, 0, 'W', { stats: { hp: 30, atk: 8, mag: 2, def: 4, res: 2, spd: 6, move: 4, jump: 2, eva: 200 } })]);
    expect(v0(s2, 'bw', 'shoot', 2, 0).hit).toBe(10);
  });

  it('ranged height bonus: +1 max range for range ≥3 when 2+ above', () => {
    const s = battle(['2 0 0 0 0 0 0'], [unit('bw', 'player', 'bowhand', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 6, 0, 'W')]);
    expect(targetTiles(s, getUnit(s, 'bw'), 'shoot')).toEqual([{ x: 6, y: 0 }]);
  });

  it('Thrust needs a straight line', () => {
    const s = battle(flatRows(3, 3), [{ ...unit('sp', 'enemy', 'sellsword', 0, 0), abilities: ['thrust'] }, unit('a', 'player', 'sellsword', 1, 1)]);
    expect(targetTiles(s, getUnit(s, 'sp'), 'thrust')).toEqual([]);
  });

  it('Shove into a wall adds +3; off a 2-level drop moves and adds +3', () => {
    const s = battle(['0 0 X'], [unit('a', 'player', 'sellsword', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 1, 0, 'W')]);
    const v = v0(s, 'a', 'shove', 1, 0);
    expect(v.damage).toBe(2 + 8 - 4 + 3);
    expect(v.pushedTo).toBeUndefined();
    const s2 = battle(['2 2 0'], [unit('a', 'player', 'sellsword', 0, 0, 'E'), unit('e', 'enemy', 'sellsword', 1, 0, 'W')]);
    const v2 = v0(s2, 'a', 'shove', 1, 0);
    expect(v2.pushedTo).toEqual({ x: 2, y: 0 });
    expect(v2.damage).toBe(2 + 8 - 4 + 3);
  });

  it('Cleave hits the target and the two tiles beside it, enemies only', () => {
    const s = battle(flatRows(3, 3), [unit('a', 'player', 'sellsword', 1, 2), unit('e1', 'enemy', 'sellsword', 0, 1), unit('e2', 'enemy', 'sellsword', 1, 1), unit('p', 'player', 'sellsword', 2, 1)]);
    const ids = previewAction(s, getUnit(s, 'a'), 'cleave', { x: 1, y: 1 }).victims.map((v) => v.unitId);
    expect(ids.sort()).toEqual(['e1', 'e2']);
  });

  it('Volley hits allies too', () => {
    const s = battle(flatRows(6, 3), [unit('bw', 'player', 'bowhand', 0, 1, 'E'), unit('e', 'enemy', 'sellsword', 4, 1), unit('p', 'player', 'sellsword', 4, 0)]);
    const ids = previewAction(s, getUnit(s, 'bw'), 'volley', { x: 4, y: 1 }).victims.map((v) => v.unitId);
    expect(ids.sort()).toEqual(['e', 'p']);
  });
});
