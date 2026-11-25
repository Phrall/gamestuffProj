import Phaser from 'phaser';
import manifest from '../assets/audio/audio_manifest.json';
import { ABILITIES } from './data';

// Audio (Audio's PR #11). Vite fingerprints every file under assets/audio; Phaser picks .ogg, else .mp3.
const files = import.meta.glob('../assets/audio/**/*.{ogg,mp3}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

type Entry = { volume: number; loop?: boolean; variants?: string[]; random_pitch?: number; duck_music?: boolean };
const MUSIC = manifest.music as Record<string, Entry>;
const SFX = manifest.sfx as Record<string, Entry>;
const BUS = manifest.buses as { music: number; sfx: number };

/** Every file key (variants included), with its ogg and mp3 URLs. */
function sources(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [path, url] of Object.entries(files)) {
    const key = path.split('/').pop()!.replace(/\.(ogg|mp3)$/, '');
    const list = out.get(key) ?? [];
    if (path.endsWith('.ogg')) list.unshift(url); else list.push(url);
    out.set(key, list);
  }
  return out;
}

export function preloadAudio(scene: Phaser.Scene): void {
  for (const [key, urls] of sources()) scene.load.audio(key, urls);
}

let music: Phaser.Sound.BaseSound | null = null;
let musicKey: string | null = null;
const musicVol = (key: string) => BUS.music * (MUSIC[key]?.volume ?? 1);
const has = (scene: Phaser.Scene, key: string) => scene.cache.audio.exists(key);

/** Start a music track (no-op if it is already playing). Waits for the browser's audio unlock. */
export function playMusic(scene: Phaser.Scene, key: string): void {
  if (musicKey === key && music?.isPlaying) return;
  const start = () => {
    if (!has(scene, key)) return;
    music?.stop(); music?.destroy();
    musicKey = key;
    music = scene.sound.add(key, { loop: MUSIC[key]?.loop ?? false, volume: musicVol(key) });
    music.play();
  };
  if (scene.sound.locked) scene.sound.once(Phaser.Sound.Events.UNLOCKED, start); else start();
}

/** Fade the current track out, then play a sting (victory/defeat). */
export function sting(scene: Phaser.Scene, key: string): void {
  const old = music;
  music = null; musicKey = null;
  if (old) scene.tweens.killTweensOf(old); // a duck may still be running on it
  if (old) scene.tweens.add({ targets: old, volume: 0, duration: 300, onComplete: () => { old.stop(); old.destroy(); } });
  scene.time.delayedCall(old ? 300 : 0, () => { if (has(scene, key)) scene.sound.play(key, { volume: musicVol(key) }); });
}

/** Duck music ~6 dB for 2 s under the signature vow sounds. */
function duck(scene: Phaser.Scene): void {
  const m = music as Phaser.Sound.WebAudioSound | null;
  if (!m || !musicKey || m.pendingRemove || !m.isPlaying) return;
  const full = musicVol(musicKey);
  scene.tweens.killTweensOf(m);
  scene.tweens.add({ targets: m, volume: full * 0.5, duration: 120, yoyo: true, hold: 1800 });
}

/** Play a sound effect by manifest key: picks a variant, applies random pitch and ducking. */
export function sfx(scene: Phaser.Scene, key: string, volumeScale = 1): void {
  const e = SFX[key];
  if (!e) return;
  const file = e.variants ? e.variants[Math.floor(Math.random() * e.variants.length)]! : key;
  if (!has(scene, file)) return;
  const detune = e.random_pitch ? (Math.random() * 2 - 1) * e.random_pitch * 1200 : 0;
  scene.sound.play(file, { volume: BUS.sfx * e.volume * volumeScale, detune });
  if (e.duck_music) duck(scene);
}

/** Sound for an ability's cast: bow twang for ranged physical, cast for magic, heal for support. */
export function abilitySound(abilityId: string): string | null {
  const a = ABILITIES[abilityId];
  if (!a) return null;
  if (a.type === 'phys') return a.melee ? null : 'atk_bow';
  if (a.type === 'magic') return 'ability_cast';
  return 'ability_heal';
}

/** Whether an ability's results should play hit/miss sounds. */
export const isAttack = (abilityId: string) => ['phys', 'magic'].includes(ABILITIES[abilityId]?.type ?? '');

/** Wire hover and click sounds onto an interactive button. */
export function buttonSounds(scene: Phaser.Scene, obj: Phaser.GameObjects.GameObject, click = 'ui_click'): void {
  obj.on('pointerover', () => sfx(scene, 'ui_hover'));
  obj.on('pointerdown', () => sfx(scene, click));
}

// ---------- master volume / mute (QA) ----------
const LEVELS = [1, 0.6, 0.3, 0];
const STORE = 'oathbound.volume';
let level = (() => { try { const v = Number(localStorage.getItem(STORE)); return LEVELS.includes(v) && localStorage.getItem(STORE) !== null ? v : 1; } catch { return 1; } })();
let beforeMute = level || 1;

function apply(scene: Phaser.Scene, v: number): void {
  level = v;
  if (v > 0) beforeMute = v;
  scene.sound.volume = v;
  try { localStorage.setItem(STORE, String(v)); } catch { /* private mode: not remembered */ }
}

export const volumeLevel = () => level;
/** Apply the remembered volume to this game's sound manager. */
export const initVolume = (scene: Phaser.Scene) => { scene.sound.volume = level; };
/** Button: 100% → 60% → 30% → off → 100%. */
export const cycleVolume = (scene: Phaser.Scene) => apply(scene, LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length]!);
/** M key: mute, or restore the last level. */
export const toggleMute = (scene: Phaser.Scene) => apply(scene, level > 0 ? 0 : beforeMute);
export const volumeLabel = () => (level === 0 ? '♪ off' : `♪ ${Math.round(level * 100)}%`);
