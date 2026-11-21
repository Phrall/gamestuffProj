import { describe, expect, it } from 'vitest';
import { key } from '../src/core/grid';
import { pathTo, pathTree, reachableTiles } from '../src/core/pathfinding';
import { battle, flatRows, unit } from './helpers';

const costs = (s: ReturnType<typeof battle>, id: string) =>
  new Map(reachableTiles(s, s.units.find((u) => u.id === id)!).map((n) => [key(n.pos), n.cost]));

describe('pathfinding (§3)', () => {
  it('climbing costs 1 + height climbed; dropping costs 1', () => {
    const s = battle(['0 2 0 0 0'], [unit('a', 'player', 'sellsword', 0, 0)]);
    const c = costs(s, 'a');
    expect(c.get('1,0')).toBe(3);
    expect(c.get('2,0')).toBe(4);
    expect(c.has('3,0')).toBe(false); // Move 4 used up
  });

  it('blocks climbs above Jump and drops above Jump + 1', () => {
    const s = battle(['0 3 0', '0 0 0', '4 0 0'], [unit('a', 'player', 'sellsword', 0, 0), unit('b', 'player', 'sellsword', 0, 2)]);
    expect(costs(s, 'a').has('1,0')).toBe(false); // climb 3 > Jump 2
    expect(costs(s, 'b').has('0,1')).toBe(false); // drop 4 > Jump 2 + 1
  });

  it('fords cost 2 and water and boulders block', () => {
    const s = battle(['0 F 0 W X'], [unit('a', 'player', 'sellsword', 0, 0)]);
    const c = costs(s, 'a');
    expect(c.get('1,0')).toBe(2);
    expect(c.get('2,0')).toBe(3);
    expect(c.has('3,0')).toBe(false);
  });

  it('anyone can pass a downed unit but not end on it (§8, #20)', () => {
    const s = battle(flatRows(4, 1), [unit('a', 'player', 'sellsword', 0, 0), unit('b', 'player', 'sellsword', 1, 0), unit('e', 'enemy', 'sellsword', 3, 0)]);
    s.units.find((u) => u.id === 'b')!.status = 'downed';
    expect(costs(s, 'a').has('1,0')).toBe(false);
    expect(costs(s, 'a').get('2,0')).toBe(2);
    // The enemy walks over the downed player too.
    expect(costs(s, 'e').get('0,0')).toBeUndefined(); // a stands there
    expect(pathTree(s, s.units.find((u) => u.id === 'e')!).has('1,0')).toBe(true);
  });

  it('passes through allies but not enemies, and never ends on a unit', () => {
    const s = battle(flatRows(5, 1), [unit('a', 'player', 'sellsword', 0, 0), unit('b', 'player', 'sellsword', 1, 0), unit('e', 'enemy', 'sellsword', 3, 0)]);
    const c = costs(s, 'a');
    expect(c.has('1,0')).toBe(false); // ally tile: pass only
    expect(c.get('2,0')).toBe(2);
    expect(c.has('3,0')).toBe(false);
    expect(c.has('4,0')).toBe(false);
  });

  it('Sure Footing: Bowhand gets Jump +1 and free climbs', () => {
    const s = battle(['0 3 3'], [unit('a', 'player', 'bowhand', 0, 0)]);
    expect(costs(s, 'a').get('1,0')).toBe(1);
  });

  it('returns the path in order', () => {
    const s = battle(flatRows(3, 3), [unit('a', 'player', 'sellsword', 0, 0)]);
    const u = s.units[0]!;
    const path = pathTo(pathTree(s, u), { x: 2, y: 0 });
    expect(path).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }]);
  });
});
