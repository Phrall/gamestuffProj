import Phaser from 'phaser';
import { pixelFont } from './fonts';

/**
 * Pixel-perfect view (Director, Jen's 1440p playtest; UX readability §1 and §8).
 * The game is drawn on a grid of art pixels (lp) shown at a whole-number scale k, so every art pixel is
 * exactly k device pixels: x3 at 1080p, x4 at 1440p, x6 at 4K. The logical screen is W x H lp with
 * W = floor(window / k), at least BASE; extra space goes to the map, never stretched or letterboxed.
 * Scene coordinates are "layout units", 2 per lp (the old 1280x720 layout), so cameras zoom by k / 2.
 * BASE is the one setting to change if Art moves to higher-res assets.
 */
export const BASE = { w: 640, h: 360 } as const;
/** Layout units per lp. */
export const LP = 2;

const dpr = () => window.devicePixelRatio || 1;
const deviceSize = () => ({ w: window.innerWidth * dpr(), h: window.innerHeight * dpr() });

/** Largest whole-number scale at which the base grid fits the window's device pixels. */
export function pickScale(): number {
  const d = deviceSize();
  return Math.max(1, Math.floor(Math.min(d.w / BASE.w, d.h / BASE.h)));
}

function pickLogical(scale: number): { w: number; h: number } {
  const d = deviceSize();
  return { w: Math.max(BASE.w, Math.floor(d.w / scale)), h: Math.max(BASE.h, Math.floor(d.h / scale)) };
}

let k = pickScale();
let logical = pickLogical(k);
/** Device pixels per art pixel (lp). */
export const artScale = () => k;
/** Device pixels per layout unit: the zoom every camera starts from. */
export const layoutScale = () => k / LP;
/** Logical screen in lp (W x H). */
export const screenLp = () => ({ ...logical });
/** Logical screen in layout units. */
export const layoutSize = () => ({ w: logical.w * LP, h: logical.h * LP });

export const canvasSize = () => ({ width: logical.w * k, height: logical.h * k });
/** CSS zoom that makes one canvas pixel one device pixel. */
export const cssZoom = () => 1 / dpr();

/** Point a camera of canvas size at the layout. */
export function fitCamera(cam: Phaser.Cameras.Scene2D.Camera): void {
  const { width, height } = canvasSize();
  const l = layoutSize();
  cam.setSize(width, height).setZoom(layoutScale()).centerOn(l.w / 2, l.h / 2);
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
let lastM = 0;

/** Watch the window: when the whole-number scale changes, resize the canvas and tell running scenes. */
export function watchScale(game: Phaser.Game): void {
  const apply = () => {
    const next = pickScale();
    const nextLogical = pickLogical(next);
    const nextM = mapScale();
    if (next === k && nextLogical.w === logical.w && nextLogical.h === logical.h && nextM === lastM) return;
    lastM = nextM;
    k = next;
    logical = nextLogical;
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

/**
 * Map scale M (UX v2.2 §0, B+C art): the largest whole number of device pixels per map art pixel that
 * still shows at least MAP_MIN art pixels. x1 at 720p, x2 at 1080p and 1440p, x4 at 4K. The HUD keeps S.
 * Map art is 1 art px per world unit (64x32 tile tops), so the main camera's zoom is M itself.
 */
export const MAP_MIN = { w: 960, h: 540 } as const;
export function mapScale(): number {
  const d = deviceSize();
  return Math.max(1, Math.floor(Math.min(d.w / MAP_MIN.w, d.h / MAP_MIN.h)));
}

/** Default map zoom as a multiple of the layout zoom (the camera code works relative to the HUD zoom). */
export const mapHome = (): number => mapScale() / layoutScale();

/** Map zoom steps: M-1, M and M+1 device pixels per art pixel (minimum 1), relative to the layout zoom. */
export function mapZooms(): number[] {
  const m = mapScale();
  const out: number[] = [];
  for (let p = Math.max(1, m - 1); p <= m + 1; p++) out.push(p / layoutScale());
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
