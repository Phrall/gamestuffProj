import Phaser from 'phaser';
import type { Unit } from './core/types';
import tilesPng from '../assets/art/pixel-v1/tiles.png?url';
import tilesJson from '../assets/art/pixel-v1/tiles.json';
import unitsPng from '../assets/art/pixel-v1/units.png?url';
import unitsJson from '../assets/art/pixel-v1/units.json';
import propsPng from '../assets/art/pixel-v1/props.png?url';
import propsJson from '../assets/art/pixel-v1/props.json';

// Art's pixel-v1 draft sheets (see assets/art/pixel-v1/README.md). Drawn at 2x: a 32x16 art tile
// is our 64x32 diamond, and an 8 px height step is our 16 px step.
export const ART_SCALE = 2;
export const SHEETS = ['tiles', 'units', 'props'] as const;

export function preloadArt(scene: Phaser.Scene): void {
  scene.load.atlas('tiles', tilesPng, tilesJson);
  scene.load.atlas('units', unitsPng, unitsJson);
  scene.load.atlas('props', propsPng, propsJson);
}

/** Crisp pixels for the art sheets only, so text and vector UI stay smooth. */
export function setPixelFilter(scene: Phaser.Scene): void {
  for (const k of SHEETS) if (scene.textures.exists(k)) scene.textures.get(k).setFilter(Phaser.Textures.FilterMode.NEAREST);
}

export const hasArt = (scene: Phaser.Scene): boolean => SHEETS.every((k) => scene.textures.exists(k));

/** Which drawn body a unit uses. Bowhand and Hedge Mage aren't drawn yet, so they borrow the archer and binder. */
const KIND_BY_ID: Record<string, string> = { captain: 'captain', spearA: 'spearman', spearB: 'spearman', archerA: 'archer', archerB: 'archer', binder: 'binder' };
const KIND_BY_CLASS: Record<string, string> = { sellsword: 'sellsword', bowhand: 'archer', hedgeMage: 'binder' };
export const unitKind = (u: Unit): string => KIND_BY_ID[u.id] ?? KIND_BY_CLASS[u.classId ?? ''] ?? 'sellsword';

/** Idle frame and mirror for a facing given as a screen-space direction. */
export function idleFrame(kind: string, screen: { x: number; y: number }): { frame: string; flip: boolean } {
  const down = screen.y >= 0;
  const right = screen.x >= 0;
  return { frame: `unit_${kind}_${down ? 'se' : 'ne'}_idle0`, flip: !right };
}
