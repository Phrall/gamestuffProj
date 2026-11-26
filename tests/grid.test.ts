import { describe, expect, it } from 'vitest';
import { millFordSetup, parseMap } from '../src/data';
import { facingToward, tileAt } from '../src/core/grid';

describe('map parsing', () => {
  it('reads Mill Ford heights, water, fords, bridges and boulders', () => {
    const { map } = millFordSetup();
    expect(map.width).toBe(10);
    expect(map.height).toBe(10);
    expect(tileAt(map, { x: 8, y: 0 })).toEqual({ kind: 'ground', height: 3 });
    // v1.8: the river is two rows deep, with a 2-wide bridge at x 2-3 and a 2-wide ford at x 6-7.
    for (const y of [4, 5]) {
      expect(tileAt(map, { x: 0, y })?.kind).toBe('water');
      expect(tileAt(map, { x: 2, y })).toEqual({ kind: 'ground', height: 1, bridge: true });
      expect(tileAt(map, { x: 3, y })?.bridge).toBe(true);
      expect(tileAt(map, { x: 6, y })?.kind).toBe('ford');
      expect(tileAt(map, { x: 7, y })?.kind).toBe('ford');
    }
    expect(tileAt(map, { x: 6, y: 2 })?.kind).toBe('boulder');
    expect(tileAt(map, { x: 2, y: 7 })?.height).toBe(3);
  });

  it('rejects ragged rows', () => {
    expect(() => parseMap({ id: 'x', name: 'x', width: 3, height: 1, rows: ['0 0'] })).toThrow();
  });

  it('places the squad and patrol from the data file', () => {
    const { units } = millFordSetup();
    expect(units.filter((u) => u.team === 'player').map((u) => u.id)).toEqual(['maren', 'tobin', 'wren', 'calla']);
    expect(units.filter((u) => u.team === 'enemy')).toHaveLength(5);
  });
});

describe('facingToward', () => {
  it('uses the dominant axis', () => {
    expect(facingToward({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe('E');
    expect(facingToward({ x: 0, y: 0 }, { x: 1, y: -3 })).toBe('N');
  });
});
