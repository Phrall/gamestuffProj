import Phaser from 'phaser';
import { pixelFont } from './fonts';

/**
 * Pixel-perfect view (Director, Jen's 1440p playtest; UX readability pass §1).
 * The game is drawn on a BASE grid of art pixels and shown at a whole-number scale k, so every
 * art pixel is exactly k device pixels: x3 at 1080p, x4 at 1440p, x6 at 4K. The rest letterboxes.
 * Scenes keep their 1280x720 layout coordinates (2 per base pixel), and each camera zooms by S = k / 2.
 * BASE is the one setting to change if Art moves to higher-res assets.
 */
export const BASE = { w: 640, h: 360 } as const;
export const LAYOUT = { w: 1280, h: 720 } as const;

const dpr = () => window.devicePixelRatio || 1;

/** Largest whole-number scale at which the base grid fits the window's device pixels. */
export function pickScale(): number {
  return Math.max(1, Math.floor(Math.min((window.innerWidth * dpr()) / BASE.w, (window.innerHeight * dpr()) / BASE.h)));
}

let k = pickScale();
/** Device pixels per base (art) pixel. */
export const artScale = () => k;
/** Device pixels per layout unit: the zoom every camera starts from. */
export const layoutScale = () => (k * BASE.w) / LAYOUT.w;

export const canvasSize = () => ({ width: BASE.w * k, height: BASE.h * k });
/** CSS zoom that makes one canvas pixel one device pixel. */
export const cssZoom = () => 1 / dpr();

/** Point a camera of canvas size at the 1280x720 layout. */
export function fitCamera(cam: Phaser.Cameras.Scene2D.Camera): void {
  const { width, height } = canvasSize();
  cam.setSize(width, height).setZoom(layoutScale()).centerOn(LAYOUT.w / 2, LAYOUT.h / 2);
}

/** Text drawn at device resolution, so it stays sharp under the camera zoom. */
export function crispText(t: Phaser.GameObjects.Text): Phaser.GameObjects.Text {
  return t.setResolution(Math.max(1, layoutScale()));
}

function sharpenTexts(list: Phaser.GameObjects.GameObject[]): void {
  for (const o of list) {
    if (o instanceof Phaser.GameObjects.Text) crispText(o);
    else if (o instanceof Phaser.GameObjects.Container) sharpenTexts(o.list);
  }
}

export const RESCALE = 'view-rescale';

/** Watch the window: when the whole-number scale changes, resize the canvas and tell running scenes. */
export function watchScale(game: Phaser.Game): void {
  const apply = () => {
    const next = pickScale();
    if (next === k) return;
    k = next;
    const { width, height } = canvasSize();
    game.scale.resize(width, height);
    game.scale.setZoom(cssZoom());
    for (const s of game.scene.getScenes(true)) {
      sharpenTexts(s.children.list);
      s.events.emit(RESCALE);
    }
  };
  window.addEventListener('resize', apply);
}

/** Map zoom steps (UX camera spec): S-1 to S+2 device pixels per art pixel, as a multiple of the layout zoom. */
export function mapZooms(): number[] {
  const out: number[] = [];
  for (let p = Math.max(1, k - 1); p <= k + 2; p++) out.push(p / k);
  return out;
}

/** Every scene.add.text gets device resolution (Menu, Results, dialogue and the HUD alike). */
export function installCrispText(): void {
  const proto = Phaser.GameObjects.GameObjectFactory.prototype as unknown as { text: (...a: unknown[]) => Phaser.GameObjects.Text };
  const orig = proto.text;
  proto.text = function (this: unknown, ...a: unknown[]) {
    // Every text goes onto the pixel-font scale (Tiny5 8 lp / Pixelify 16 lp), whatever size the caller asked for.
    const style = { ...((a[3] as Phaser.Types.GameObjects.Text.TextStyle | undefined) ?? {}) };
    const asked = parseInt(String(style.fontSize ?? '16'), 10) || 16;
    Object.assign(style, pixelFont(asked));
    a[3] = style;
    return crispText(orig.apply(this, a));
  };
}

/** Standard fit for a scene with one camera: fit now and again whenever the scale changes. */
export function fitScene(scene: Phaser.Scene): void {
  const refit = () => fitCamera(scene.cameras.main);
  refit();
  scene.events.on(RESCALE, refit);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => scene.events.off(RESCALE, refit));
}
