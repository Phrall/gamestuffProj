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
  /** View rotation in quarter turns (0-3). Needs mapW/mapH when not 0. */
  rot?: number;
  mapW?: number;
  mapH?: number;
}

export interface Vec { x: number; y: number }

const rot = (c: IsoConfig): number => (((c.rot ?? 0) % 4) + 4) % 4;

/**
 * Map coordinates to view coordinates for the current rotation. Each quarter turn
 * turns the board 90° clockwise on screen; the view is always drawn back (low x+y)
 * to front (high x+y).
 */
export function toView(c: IsoConfig, x: number, y: number): Vec {
  const w = (c.mapW ?? 1) - 1;
  const h = (c.mapH ?? 1) - 1;
  switch (rot(c)) {
    case 1: return { x: h - y, y: x };
    case 2: return { x: w - x, y: h - y };
    case 3: return { x: y, y: w - x };
    default: return { x, y };
  }
}

/** A map direction (e.g. a facing) turned into view space. */
export function viewDir(c: IsoConfig, d: Vec): Vec {
  switch (rot(c)) {
    case 1: return { x: -d.y, y: d.x };
    case 2: return { x: -d.x, y: -d.y };
    case 3: return { x: d.y, y: -d.x };
    default: return { x: d.x, y: d.y };
  }
}

/** Screen direction of a view-space step (for facing arrows). */
export function screenDir(c: IsoConfig, d: Vec): Vec {
  const v = viewDir(c, d);
  return { x: v.x - v.y, y: (v.x + v.y) / 2 };
}

/** Draw order of a tile: higher is nearer the viewer. */
export function depthOf(c: IsoConfig, x: number, y: number): number {
  const v = toView(c, x, y);
  return v.x + v.y;
}

/** Screen position of the center of a tile's top face. */
export function tileCenter(c: IsoConfig, x: number, y: number, h: number): Vec {
  const v = toView(c, x, y);
  return {
    x: c.originX + (v.x - v.y) * (c.tileW / 2),
    y: c.originY + (v.x + v.y) * (c.tileH / 2) - h * c.step,
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
  const tiles: Vec[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) tiles.push({ x, y });
  tiles.sort((a, b) => depthOf(c, b.x, b.y) - depthOf(c, a.x, a.y));
  for (const t of tiles) {
    if (pointInPolygon(p, silhouette(c, t.x, t.y, heightOf(t.x, t.y)))) return t;
  }
  return null;
}
