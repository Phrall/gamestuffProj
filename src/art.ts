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
}

const ART_KEYS = ['tileset', 'bow', 'fighter-attackSE', 'fighter_oc-attackSE', 'mage-attackSE', 'cleric_oc-attackSE'];

/** Crisp pixels for the art only (text and vector UI stay smooth), plus the walk and attack animations. */
export function setupArt(scene: Phaser.Scene): void {
  for (const k of scene.textures.getTextureKeys()) {
    if (k === 'tileset' || k === 'bow' || k.startsWith('weapon-') || BODIES.some((b) => k.startsWith(`${b}-`))) {
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
} as const;
