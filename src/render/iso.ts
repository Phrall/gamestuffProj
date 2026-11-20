// Isometric projection for the gray-box renderer. Pure math, no Phaser.

export interface IsoConfig {
  originX: number;
  originY: number;
  /** Full width of a tile's top diamond. */
  tileW: number;
  /** Full height of a tile's top diamond. */
  tileH: number;
  /** Screen pixels per height level. */
  step: number;
}

export interface Vec { x: number; y: number }

/** Screen position of the center of a tile's top face. */
export function tileCenter(c: IsoConfig, x: number, y: number, h: number): Vec {
  return {
    x: c.originX + (x - y) * (c.tileW / 2),
    y: c.originY + (x + y) * (c.tileH / 2) - h * c.step,
  };
}

/** Top diamond corners: north, east, south, west. */
export function topDiamond(c: IsoConfig, x: number, y: number, h: number): Vec[] {
  const m = tileCenter(c, x, y, h);
  const hw = c.tileW / 2;
  const hh = c.tileH / 2;
  return [
    { x: m.x, y: m.y - hh },
    { x: m.x + hw, y: m.y },
    { x: m.x, y: m.y + hh },
    { x: m.x - hw, y: m.y },
  ];
}

/** Whole visible silhouette of a raised tile (top plus both side faces down to ground). */
export function silhouette(c: IsoConfig, x: number, y: number, h: number): Vec[] {
  const [n, e, s, w] = topDiamond(c, x, y, h) as [Vec, Vec, Vec, Vec];
  const drop = Math.max(h, 0) * c.step + c.step / 2;
  return [n, e, { x: e.x, y: e.y + drop }, { x: s.x, y: s.y + drop }, { x: w.x, y: w.y + drop }, w];
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Which tile is under a screen point. Front-most tiles are tested first so a raised
 * tile hides the tiles behind it.
 */
export function pickTile(c: IsoConfig, width: number, height: number, heightOf: (x: number, y: number) => number, p: Vec): Vec | null {
  for (let sum = width + height - 2; sum >= 0; sum--) {
    for (let x = Math.min(sum, width - 1); x >= 0 && sum - x < height; x--) {
      const y = sum - x;
      if (pointInPolygon(p, silhouette(c, x, y, heightOf(x, y)))) return { x, y };
    }
  }
  return null;
}
