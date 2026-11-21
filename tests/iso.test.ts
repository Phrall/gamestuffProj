import { describe, expect, it } from 'vitest';
import { pickTile, tileCenter, type IsoConfig } from '../src/render/iso';

const c: IsoConfig = { originX: 400, originY: 100, tileW: 64, tileH: 32, step: 16 };

describe('isometric picking (#2)', () => {
  it('picks the tile under its own top center', () => {
    const flat = () => 0;
    for (const [x, y] of [[0, 0], [3, 7], [9, 9], [9, 0]] as const) {
      expect(pickTile(c, 10, 10, flat, tileCenter(c, x, y, 0))).toEqual({ x, y });
    }
  });

  it('a raised tile in front hides the tile behind it', () => {
    const heights = (x: number, y: number) => (x === 5 && y === 5 ? 3 : 0);
    // The ground tile (4,4) sits right behind (5,5); the raised tile covers its center.
    expect(pickTile(c, 10, 10, heights, tileCenter(c, 4, 4, 0))).toEqual({ x: 5, y: 5 });
    expect(pickTile(c, 10, 10, heights, tileCenter(c, 5, 5, 3))).toEqual({ x: 5, y: 5 });
  });

  it('returns null off the map', () => {
    expect(pickTile(c, 10, 10, () => 0, { x: 0, y: 0 })).toBeNull();
  });
});

describe('view rotation (#19)', () => {
  const heights = (x: number, y: number) => (x === 5 && y === 5 ? 3 : 0);
  it('picks the right tile at every rotation', () => {
    for (let r = 0; r < 4; r++) {
      const cr = { ...c, rot: r, mapW: 10, mapH: 6 };
      for (const [x, y] of [[0, 0], [3, 5], [9, 5], [9, 0]] as const) {
        expect(pickTile(cr, 10, 6, () => 0, tileCenter(cr, x, y, 0))).toEqual({ x, y });
      }
    }
  });
  it('a tile hidden at one rotation is visible after turning the view', () => {
    const r0 = { ...c, rot: 0, mapW: 10, mapH: 10 };
    const r2 = { ...c, rot: 2, mapW: 10, mapH: 10 };
    expect(pickTile(r0, 10, 10, heights, tileCenter(r0, 4, 4, 0))).toEqual({ x: 5, y: 5 });
    expect(pickTile(r2, 10, 10, heights, tileCenter(r2, 4, 4, 0))).toEqual({ x: 4, y: 4 });
  });
});
