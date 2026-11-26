import Phaser from 'phaser';
import type { Unit } from './core/types';

// Tiny Tactics - Battle Kit I (tiopalada, CC0) and Pixel Bow Pack (Stealthix, CC0), prepared by
// tools/art/build_tiny_tactics.py. Everything is drawn at 2x: a 32x16 art tile top is our 64x32 diamond.
export const ART_SCALE = 2;

const files = import.meta.glob('../assets/art/tiny-tactics/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const url = (name: string): string => {
  const hit = Object.entries(files).find(([p]) => p.endsWith(`/${name}.png`));
  if (!hit) throw new Error(`missing art ${name}`);
  return hit[1];
};

type Body = 'fighter' | 'fighter_oc' | 'mage' | 'cleric' | 'cleric_oc';
type Weapon = 'IronSword' | 'IronAxe' | 'WoodenStaff' | 'Scepter' | 'bow';
const BODIES: Body[] = ['fighter', 'fighter_oc', 'mage', 'cleric', 'cleric_oc'];
const POSES = ['walking', 'attack', 'dead', 'weak', 'damage', 'release'] as const;
const FACES = ['NE', 'SE'] as const;
const WEAPONS: Exclude<Weapon, 'bow'>[] = ['IronSword', 'IronAxe', 'WoodenStaff', 'Scepter'];

export function preloadArt(scene: Phaser.Scene): void {
  for (const b of BODIES) for (const p of POSES) for (const f of FACES) {
    scene.load.spritesheet(`${b}-${p}${f}`, url(`${b}-${p}${f}`), { frameWidth: 32, frameHeight: 32 });
  }
  for (const w of WEAPONS) for (const f of FACES) scene.load.spritesheet(`weapon-${w}${f}`, url(`weapon-${w}${f}`), { frameWidth: 48, frameHeight: 48 });
  scene.load.spritesheet('tileset', url('tileset'), { frameWidth: 32, frameHeight: 32 });
  scene.load.image('bow', url('bow'));
  scene.load.image('gui-panel', url('gui-panel'));
  for (const s of BUTTON_STATES) scene.load.image(`gui-button-${s}`, url(`gui-button-${s}`));
  // HUD at 1 lp (UX §8): action tabs, timeline chips, the camera plate and the small round buttons.
  for (let i = 0; i < 4; i++) { scene.load.image(`gui-tab-${i}`, url(`gui-tab-${i}`)); scene.load.image(`gui-chip-${i}`, url(`gui-chip-${i}`)); }
  scene.load.image('gui-plate', url('gui-plate'));
  for (const k of ['gui-less', 'gui-more', 'gui-left', 'gui-right', 'gui-rotl', 'gui-rotr', 'gui-centre']) scene.load.spritesheet(k, url(k), { frameWidth: 16, frameHeight: 16 });
  for (const k of ['gui-options', 'gui-help']) scene.load.spritesheet(k, url(k), { frameWidth: 24, frameHeight: 24 });
}

/** Layout units per art pixel: HUD pieces draw at 1 lp (view.ts LP). */
const HUD_SCALE = 2;

/** 9-slice B panel at 1 lp. Position in layout units, size in lp. */
export function hudPanel(scene: Phaser.Scene, x: number, y: number, wLp: number, hLp: number): Phaser.GameObjects.NineSlice | null {
  if (!guiOn(scene)) return null;
  return scene.add.nineslice(x, y, 'gui-panel', undefined, wLp, hLp, PANEL_SLICE, PANEL_SLICE, PANEL_SLICE, PANEL_SLICE).setOrigin(0).setScale(HUD_SCALE);
}

/** 9-slice C plate at 1 lp (camera cluster, round-button backs). */
export function hudPlate(scene: Phaser.Scene, x: number, y: number, wLp: number, hLp: number): Phaser.GameObjects.NineSlice | null {
  if (!guiOn(scene)) return null;
  return scene.add.nineslice(x, y, 'gui-plate', undefined, wLp, hLp, 6, 6, 6, 6).setOrigin(0).setScale(HUD_SCALE);
}

/** TabC frames: 0 rest, 1 hover, 2 pressed, 3 disabled and cooldown. */
export type TabFrame = 0 | 1 | 2 | 3;
const TAB_SLICE = { l: 8, r: 10 };

/** Action button: the TabC sheet 3-sliced to wLp x 22 lp. */
export function hudTab(scene: Phaser.Scene, x: number, y: number, wLp: number): Phaser.GameObjects.NineSlice | null {
  if (!guiOn(scene)) return null;
  const b = scene.add.nineslice(x, y, 'gui-tab-0', undefined, wLp, 22, TAB_SLICE.l, TAB_SLICE.r, 0, 0).setOrigin(0).setScale(HUD_SCALE);
  b.setData('frame', 0);
  return b;
}

export function setTabFrame(b: Phaser.GameObjects.NineSlice, f: TabFrame): void {
  if (b.getData('frame') === f) return;
  b.setData('frame', f);
  const { width, height } = b;
  b.setTexture(`gui-tab-${f}`);
  b.setSlices(width, height, TAB_SLICE.l, TAB_SLICE.r, 0, 0);
}

/** A 1 lp image from the HUD sheets (chips, round buttons, arrows), top-left origin. */
export function hudImage(scene: Phaser.Scene, x: number, y: number, key: string, frame = 0): Phaser.GameObjects.Image | null {
  if (!guiOn(scene) || !scene.textures.exists(key)) return null;
  return scene.add.image(x, y, key, frame).setOrigin(0).setScale(HUD_SCALE);
}

// ---------- Dragon Regalia GUI (tiopalada, CC0): gold frames, fills darkened by the build script ----------
export const BUTTON_STATES = ['rest', 'hover', 'selected', 'disabled', 'primary', 'primary-hover'] as const;
export type ButtonState = (typeof BUTTON_STATES)[number];
const PANEL_SLICE = 16;
const BUTTON_SLICE = { x: 14, y: 9 };

/** NineSlice only renders under WebGL; on the canvas renderer the HUD keeps its plain rectangles. */
const guiOn = (scene: Phaser.Scene) => scene.game.renderer.type === Phaser.WEBGL && scene.textures.exists('gui-panel');

/** A framed HUD panel (top-left origin), or null when the GUI art can't draw. */
export function guiPanel(scene: Phaser.Scene, x: number, y: number, w: number, h: number): Phaser.GameObjects.NineSlice | null {
  if (!guiOn(scene)) return null;
  return scene.add.nineslice(x, y, 'gui-panel', undefined, w, h, PANEL_SLICE, PANEL_SLICE, PANEL_SLICE, PANEL_SLICE).setOrigin(0);
}

/** A framed button background (top-left origin); switch its look with setButtonState. */
export function guiButton(scene: Phaser.Scene, x: number, y: number, w: number, h: number): Phaser.GameObjects.NineSlice | null {
  if (!guiOn(scene)) return null;
  const b = scene.add.nineslice(x, y, 'gui-button-rest', undefined, w, h, BUTTON_SLICE.x, BUTTON_SLICE.x, BUTTON_SLICE.y, BUTTON_SLICE.y).setOrigin(0);
  b.setData('state', 'rest');
  return b;
}

export function setButtonState(b: Phaser.GameObjects.NineSlice, s: ButtonState): void {
  if (b.getData('state') === s) return;
  b.setData('state', s);
  const { width, height } = b;
  b.setTexture(`gui-button-${s}`);
  b.setSlices(width, height, BUTTON_SLICE.x, BUTTON_SLICE.x, BUTTON_SLICE.y, BUTTON_SLICE.y);
}

const ART_KEYS = ['tileset', 'bow', 'fighter-attackSE', 'fighter_oc-attackSE', 'mage-attackSE', 'cleric_oc-attackSE'];

/** Crisp pixels for the art only (text and vector UI stay smooth), plus the walk and attack animations. */
export function setupArt(scene: Phaser.Scene): void {
  for (const k of scene.textures.getTextureKeys()) {
    if (k === 'tileset' || k === 'bow' || k.startsWith('gui-') || k.startsWith('weapon-') || BODIES.some((b) => k.startsWith(`${b}-`))) {
      scene.textures.get(k).setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
  }
  for (const b of BODIES) for (const f of FACES) {
    const walk = `${b}-walking${f}`;
    if (scene.textures.exists(walk) && !scene.anims.exists(walk)) {
      scene.anims.create({ key: walk, frames: scene.anims.generateFrameNumbers(walk, { start: 0, end: 7 }), frameRate: 12, repeat: -1 });
    }
    const atk = `${b}-attack${f}`;
    if (scene.textures.exists(atk) && !scene.anims.exists(atk)) {
      scene.anims.create({ key: atk, frames: scene.anims.generateFrameNumbers(atk, { start: 0, end: 3 }), frameRate: 12 });
    }
  }
  for (const w of WEAPONS) for (const f of FACES) {
    const k = `weapon-${w}${f}`;
    if (scene.textures.exists(k) && !scene.anims.exists(k)) {
      scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(k, { start: 0, end: 3 }), frameRate: 12 });
    }
  }
}

export const hasArt = (scene: Phaser.Scene): boolean => ART_KEYS.every((k) => scene.textures.exists(k));

/** Art's unit mapping (packs/README.md): body, weapon, and the Oathcourt recolour for enemies. */
export function unitLook(u: Unit): { body: Body; weapon: Weapon } {
  const enemy = u.team === 'enemy';
  if (enemy) {
    if (u.id === 'binder') return { body: 'cleric_oc', weapon: 'Scepter' };
    if (u.id.startsWith('archer')) return { body: 'fighter_oc', weapon: 'bow' };
    if (u.id.startsWith('spear')) return { body: 'fighter_oc', weapon: 'IronAxe' };
    return { body: 'fighter_oc', weapon: 'IronSword' };
  }
  if (u.classId === 'bowhand') return { body: 'fighter', weapon: 'bow' };
  if (u.classId === 'hedgeMage') return { body: 'mage', weapon: 'WoodenStaff' };
  return { body: 'fighter', weapon: 'IronSword' };
}

/** Pack facing for a screen-space direction: SE/NE art, mirrored for the left-hand facings. */
export function face(screen: { x: number; y: number }): { f: 'NE' | 'SE'; flip: boolean } {
  return { f: screen.y >= 0 ? 'SE' : 'NE', flip: screen.x < 0 };
}

/** Tileset cells (32x32, 16 per row). Full blocks have 16 px sides (2 height levels), half blocks 8 px. */
export const TILE = {
  grassFull: 0, grassHalf: 1,
  dirtFull: 11, dirtHalf: 12,
  waterFull: 32, waterHalf: 33,
  bridgeHalf: 85,
  rock: 64,
  stones: 80, // (0,5): small grey rocks, the ford's stepping stones
} as const;

/**
 * River half-blocks with foam on the screen-space edges that touch land (Art, measured from the tileset).
 * Key: which of NW, NE, SE, SW border land. Opposite pairs have no tile; the nearer-camera side is used.
 */
export const WATER_FOAM: Record<string, number> = {
  '': 33, NW: 53, NE: 38, SE: 55, SW: 70,
  'NW+NE': 37, 'NE+SE': 39, 'SE+SW': 71, 'NW+SW': 69,
};
