import type { Facing, GridMap, Point, Tile } from './types';

export const DIRS: Record<Facing, Point> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};
export const FACINGS: Facing[] = ['N', 'E', 'S', 'W'];

export const key = (p: Point): string => `${p.x},${p.y}`;
export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
export const manhattan = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function inBounds(map: GridMap, p: Point): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height;
}

export function tileAt(map: GridMap, p: Point): Tile | undefined {
  return inBounds(map, p) ? map.tiles[p.y * map.width + p.x] : undefined;
}

export function isPassable(tile: Tile | undefined): boolean {
  return !!tile && tile.kind !== 'water' && tile.kind !== 'boulder';
}

export function heightAt(map: GridMap, p: Point): number {
  return tileAt(map, p)?.height ?? 0;
}

export function neighbors(map: GridMap, p: Point): Point[] {
  return FACINGS.map((f) => ({ x: p.x + DIRS[f].x, y: p.y + DIRS[f].y })).filter((q) => inBounds(map, q));
}

/** The facing that points from `from` toward `to` along the dominant axis. */
export function facingToward(from: Point, to: Point, fallback: Facing = 'S'): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}
