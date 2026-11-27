import { describe, expect, it } from 'vitest';
import { key } from '../src/core/grid';
import { dangerZone, unitReach } from '../src/core/threat';
import { battle, flatRows, unit } from './helpers';

const keys = (ps: { x: number; y: number }[]) => new Set(ps.map(key));

describe('danger zone (UX slice §1)', () => {
  it('covers move tiles plus ability range from each of them', () => {
    const s = battle(flatRows(12, 1), [unit('p', 'player', 'sellsword', 0, 0), unit('e', 'enemy', 'sellsword', 11, 0)]);
    const e = s.units.find((u) => u.id === 'e')!;
    e.abilities = ['thrust'];
    const r = unitReach(s, e);
    const hit = keys(r.hit);
    // Move 4 from x 11 reaches x 7; Thrust 1–2 straight hits x 5 to x 10 (and the tiles it can stand on).
    expect(hit.has('5,0')).toBe(true);
    expect(hit.has('4,0')).toBe(false);
  });

  it('leaves water out and skips abilities still cooling down next turn', () => {
    const s = battle(['0 0 W 0 0 0 0 0'], [unit('p', 'player', 'sellsword', 0, 0), unit('e', 'enemy', 'sellsword', 7, 0)]);
    const e = s.units.find((u) => u.id === 'e')!;
    e.abilities = ['thrust', 'cleave'];
    e.cooldowns = { cleave: 2 };
    const r = unitReach(s, e);
    expect(r.abilities).toEqual(['thrust']);
    expect(keys(r.hit).has('2,0')).toBe(false);
  });

  it('ignores heals and only counts standing enemies of the other team', () => {
    const s = battle(flatRows(6, 6), [unit('p', 'player', 'sellsword', 0, 0), unit('e', 'enemy', 'sellsword', 5, 5)]);
    const e = s.units.find((u) => u.id === 'e')!;
    e.abilities = ['binderMend'];
    expect(dangerZone(s).tiles).toEqual([]);
    e.abilities = ['strike'];
    e.status = 'downed';
    expect(dangerZone(s).reaches).toEqual([]);
  });
});
