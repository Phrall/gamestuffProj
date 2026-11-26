import Phaser from 'phaser';
import { ABILITIES, CLASSES, VOWS, millFordSetup } from '../data';
import { planTurn } from '../core/ai';
import { activeUnit, createBattle, endTurn, getUnit, moveUnit, startNextTurn, useAbility, type BattleState } from '../core/battle';
import { abilityReady, areaTiles, inRange, previewAction, targetTiles } from '../core/combat';
import { DIRS, FACINGS, facingToward, heightAt, key, samePoint, tileAt } from '../core/grid';
import { occupant, pathTo, pathTree, reachableTiles } from '../core/pathfinding';
import { effectiveStats, teamMorale } from '../core/stats';
import { forecast } from '../core/timeline';
import { swearVow, vowDef } from '../core/vows';
import { movePreview, type MovePreview, type Threat } from '../core/movePreview';
import type { ActionPreview, BattleEvent, Facing, Point, Unit, VowId } from '../core/types';
import { depthOf, pickTile, screenDir, tileCenter, topDiamond, viewDir, type IsoConfig, type Vec } from '../render/iso';
import { COLORS, FACTION, FONT, MARK } from './theme';
import { LP, RESCALE, canvasSize, fitCamera, layoutScale, layoutSize, mapZooms, screenLp } from '../view';
import { abilityName, abilityParams, abilityShort, bark, lookup, moraleParams, scene, t, unitName, unitShort, vowName, vowParams } from '../data/strings';
import { playDialogue } from './dialogue';
import { mulberry32 } from '../core/rng';
import { ART_SCALE, TILE, face, guiButton, guiPanel, hasArt, hudImage, hudPanel, hudPlate, hudTab, setButtonState, setTabFrame, unitLook, type ButtonState, type TabFrame } from '../art';
import { abilitySound, buttonSounds, cycleVolume, initVolume, isAttack, playMusic, sfx, sting, toggleMute, volumeLabel } from '../audio';

type Mode =
  | { kind: 'busy' }
  | { kind: 'deploy' }
  | { kind: 'move' }
  /** selected: the first click picks a target and fills the preview; a second click, Enter or Confirm acts (UX readability §2). */
  | { kind: 'target'; abilityId: string; selected?: Point }
  | { kind: 'facing'; facing: Facing };

interface UnitView {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  glyph: Phaser.GameObjects.Text;
  hp: Phaser.GameObjects.Graphics;
  nub: Phaser.GameObjects.Graphics;
  sigil: Phaser.GameObjects.Graphics;
  sigilText: Phaser.GameObjects.Text;
  /** Faint outline drawn above all terrain, so a unit behind high ground stays visible (UX §2). */
  outline: Phaser.GameObjects.Graphics;
  /** Sigil layer above every unit, so a sigil and its leader line are never hidden by a token in front. */
  sigilRoot: Phaser.GameObjects.Container;
  /** Pack body sprite (null in gray-box mode). */
  sprite: Phaser.GameObjects.Sprite | null;
  /** Weapon overlay (48x48 frames) or the bow image. */
  weapon: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image | null;
  /** Small team-coloured name badge shown with the sprite. */
  badge: Phaser.GameObjects.Text | null;
  /** UX §4 sprite outline: four tinted copies at ±1 art px behind the body. */
  silhouette: Phaser.GameObjects.Sprite[];
  /** ▼ over the head: bone for the active unit (bobbing), red-orange for the selected target. */
  marker: Phaser.GameObjects.Graphics;
}

// Captain is "Cp" so it never reads as Calla's "C" (QA #27).
const ENEMY_GLYPH: Record<string, string> = { captain: 'Cp', spearA: 'P1', spearB: 'P2', archerA: 'A1', archerB: 'A2', binder: 'O' };
/** Enemy ids whose role appears more than once in this battle; only those get a number (QA #27). */
let numbered = new Set<string>();
const setNumbering = (units: Unit[]): void => {
  const role = (id: string) => ENEMY_GLYPH[id]?.replace(/\d$/, '');
  const ids = units.filter((u) => u.team === 'enemy').map((u) => u.id);
  numbered = new Set(ids.filter((id) => /\d$/.test(ENEMY_GLYPH[id] ?? '') && ids.filter((o) => role(o) === role(id)).length > 1));
};
/** Board token: player units by name initial (QA #15), enemies by role, numbered only when duplicated. */
const glyphFor = (u: Unit): string => {
  if (u.team === 'player') return u.name[0]!;
  const g = ENEMY_GLYPH[u.id] ?? u.name[0]!;
  return numbered.has(u.id) ? g : g.replace(/\d$/, '');
};
/** Short name for timeline chips; numbered when two units share a name. */
const shortName = (u: Unit): string => {
  const n = u.name.replace('Court ', '');
  const tag = numbered.has(u.id) ? ENEMY_GLYPH[u.id]?.match(/\d$/)?.[0] : undefined;
  return unitShort(u.id, tag ? `${n} ${tag}` : n);
};

/** Ability display name from Writing's strings (falls back to the id, spaced out). */
export const abilityLabel = (id: string): string => {
  const n = abilityName(id);
  return n !== id ? n : id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
};

/** lp to layout units (view.ts: 2 layout units per lp). The HUD is specified in lp (UX §8). */
const X = (v: number): number => v * LP;
const DARK = '#1f1e1b';
const BONE = '#ede6d3';

/** dragonCursorTarget palette (Art, #47): its navy drop edge and the five frame colours the target pulses through. */
const CURSOR = { edge: 0x131549, pulse: [0xf7eddc, 0xf4a13a, 0xf4a13a, 0xf9d42f, 0xf8dfa6] } as const;

/** What the target panel shows (UX §8). */
interface PanelView { head: string; name?: string; big?: string; detail?: string; value?: { s: string; warn: boolean }; lines: string[]; strip?: string }

const text = (scene: Phaser.Scene, x: number, y: number, s: string, size = 14, color: string = COLORS.text) => // crisp via view.installCrispText
  scene.add.text(x, y, s, { fontFamily: FONT, fontSize: `${size}px`, color });

export default class BattleScene extends Phaser.Scene {
  state!: BattleState;
  private iso: IsoConfig = { originX: 640, originY: 150, tileW: 64, tileH: 32, step: 16 };
  private overlays: Phaser.GameObjects.Graphics[] = [];
  private views = new Map<string, UnitView>();
  private mode: Mode = { kind: 'busy' };
  private hover: Point | null = null;
  private hoverUnitId: string | null = null;
  private debug = false;
  private mapGfx: (Phaser.GameObjects.Graphics | Phaser.GameObjects.Image)[] = [];
  private barkRand: () => number = Math.random;
  private lastBarkAt: Record<string, number> = {};
  private wasShaken = false;
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  /** Pulsing outline on the confirmed target (Art: the cursor sheet's colours, code-drawn). */
  private targetMark!: Phaser.GameObjects.Graphics;
  private sorted = new WeakSet<Phaser.GameObjects.GameObject>();
  private drag: { x: number; y: number; moved: boolean; button: number } | null = null;
  private compass!: Phaser.GameObjects.Graphics;
  /** Move preview for the hovered tile (#21), cached per tile for the current turn. */
  private movePv: MovePreview | null = null;
  private movePvCache = new Map<string, MovePreview>();
  private chips: Phaser.GameObjects.GameObject[] = [];

  private timeline!: Phaser.GameObjects.Container;
  private moraleText!: Phaser.GameObjects.Text;
  private unitTitle!: Phaser.GameObjects.Text;
  private unitClass!: Phaser.GameObjects.Text;
  private unitHp!: Phaser.GameObjects.Text;
  private unitHpBar!: Phaser.GameObjects.Graphics;
  private unitBody!: Phaser.GameObjects.Text;
  private unitVow!: Phaser.GameObjects.Graphics;
  private unitVowText!: Phaser.GameObjects.Text;
  private actionHead!: Phaser.GameObjects.Text;
  /** Target panel rows (UX §8). */
  private pv!: { head: Phaser.GameObjects.Text; name: Phaser.GameObjects.Text; big: Phaser.GameObjects.Text; detail: Phaser.GameObjects.Text; value: Phaser.GameObjects.Text; body: Phaser.GameObjects.Text; strip: Phaser.GameObjects.Rectangle; stripText: Phaser.GameObjects.Text; empty: Phaser.GameObjects.Text };
  /** Target panel controls (UX §2, §3): Confirm names the action and target; arrows step targets. */
  private confirm!: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text };
  private targetArrows: Phaser.GameObjects.GameObject[] = [];
  private hint!: Phaser.GameObjects.Text;
  private hintPlate!: Phaser.GameObjects.Rectangle;
  private logText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private buttons: { id: string; bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; cd: Phaser.GameObjects.Text; ring: Phaser.GameObjects.Graphics; skin: Phaser.GameObjects.NineSlice | null; destroy: () => void }[] = [];
  private logTimes: number[] = [];
  private log: string[] = [];
  private eventCursor = 0;

  constructor() { super('Battle'); }

  create(): void {
    const seedParam = Number(new URLSearchParams(window.location.search).get('seed'));
    const seed = Number.isInteger(seedParam) && seedParam > 0 ? seedParam : (Date.now() % 1_000_000) + 1;
    const setup = millFordSetup();
    this.state = createBattle(setup, seed);
    for (const u of this.state.units) u.name = unitName(u.id, u.name);
    setNumbering(this.state.units);
    // Barks use their own RNG so flavour never shifts combat rolls (replays stay identical).
    this.barkRand = mulberry32(seed ^ 0x5eed);
    this.lastBarkAt = {};
    this.iso = { ...this.iso, rot: 0, mapW: this.state.map.width, mapH: this.state.map.height };
    this.mapGfx = [];
    this.sorted = new WeakSet();
    this.drag = null;
    this.vowChoice = Object.fromEntries(setup.units.filter((u) => u.team === 'player').map((u) => [u.id, u.suggestedVow ?? null]));
    this.views.clear();
    this.overlays = [];
    this.buttons = [];
    this.log = [];
    this.eventCursor = 0;
    this.mode = { kind: 'busy' };
    this.movePvCache = new Map();
    this.movePv = null;
    this.chips = [];

    this.art = hasArt(this);
    this.setupCameras();
    this.drawMap();
    for (const u of this.state.units) this.views.set(u.id, this.makeUnitView(u));
    this.targetMark = this.add.graphics();
    this.hudObjs = [];
    this.overlay = [];
    this.overlayKind = null;
    this.logTimes = [];
    this.buildHud();
    this.time.addEvent({ delay: 250, loop: true, callback: () => this.renderLog() });
    this.bindInput();
    this.exposeForQa();
    initVolume(this);
    playMusic(this, 'mus_camp_loop');
    this.showDeploy(seed);
  }

  // ---------- deploy and swear (§9) ----------

  private vowChoice: Record<string, VowId | null> = {};
  private deployUi: Phaser.GameObjects.GameObject[] = [];
  private redrawDeploy?: () => void;

  private showDeploy(seed: number): void {
    this.mode = { kind: 'busy' };
    this.refresh();
    const order: (VowId | null)[] = [null, 'bulwark', 'loneBlade'];
    const draw = () => {
      if (this.mode.kind !== 'deploy') return;
      for (const o of this.deployUi) o.destroy();
      this.deployUi = [];
      // Laid out for 1280 x 720 layout units; centred on the actual screen (UX §8).
      const L = layoutSize();
      const ox = Math.round((L.w - 1280) / 4) * 2, oy = Math.round((L.h - 720) / 4) * 2;
      const add = <T extends Phaser.GameObjects.GameObject>(o: T) => { this.deployUi.push(o); return o; };
      const frame = add(this.add.rectangle(330 + ox, 122 + oy, 620, 460, COLORS.panel, 0.96).setOrigin(0).setStrokeStyle(2, COLORS.gold).setDepth(3000));
      const framed = this.skinPanel(frame);
      if (framed) add(framed);
      add(text(this, 640 + ox, 140 + oy, t('ui.deploy.title'), 24, '#f5c451').setOrigin(0.5, 0).setDepth(3001));
      add(text(this, 640 + ox, 174 + oy, t('ui.deploy.subtitle'), 13, COLORS.textDim).setOrigin(0.5, 0).setDepth(3001));
      const chosen = [...new Set(Object.values(this.vowChoice).filter((v): v is VowId => !!v))];
      const notes = chosen.map((v) => `${vowName(v)}: ${t(`ui.vows.${v}.summary`, vowParams(v))} ${t(`ui.vows.${v}.breaks`, vowParams(v))}`);
      const notesY = 214 + this.state.units.filter((u) => u.team === 'player').length * 44;
      if (notes.length) add(text(this, 640 + ox, notesY + oy, notes.join('\n\n'), 13, COLORS.textDim).setOrigin(0.5, 0).setDepth(3001).setWordWrapWidth(590).setAlign('center'));
      this.state.units.filter((u) => u.team === 'player').forEach((u, i) => {
        const y = 206 + i * 44 + oy;
        const choice = this.vowChoice[u.id] ?? null;
        add(text(this, 360 + ox, y + 8, `${u.name.padEnd(7)} ${CLASSES[u.classId!]!.name}`, 16).setDepth(3001));
        const btn = add(this.add.rectangle(600 + ox, y, 320, 36, choice ? 0x3b2f12 : 0x1f2937).setOrigin(0).setStrokeStyle(1, choice ? COLORS.gold : COLORS.panelEdge).setDepth(3001).setInteractive({ useHandCursor: true }));
        const label = choice ? `${vowName(choice)}: ${t(`ui.vows.${choice}.progress`, vowParams(choice, 0))}` : t('ui.deploy.noVow');
        const skin = this.skinButton(btn, choice ? 'selected' : 'rest');
        if (skin) add(skin);
        add(text(this, 622 + ox, y + 9, label, 14, choice ? '#f5c451' : COLORS.textDim).setDepth(3002));
        btn.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
          ev.stopPropagation();
          this.vowChoice[u.id] = order[(order.indexOf(choice) + 1) % order.length]!;
          sfx(this, this.vowChoice[u.id] ? 'vow_sworn' : 'ui_back');
          draw();
        });
      });
      const go = add(this.add.rectangle(540 + ox, 524 + oy, 200, 40, 0x14532d).setOrigin(0).setStrokeStyle(2, 0x4ade80).setDepth(3001).setInteractive({ useHandCursor: true }));
      const goSkin = this.skinButton(go, 'selected');
      if (goSkin) add(goSkin);
      add(text(this, 640 + ox, 544 + oy, t('ui.deploy.begin'), 18).setOrigin(0.5).setDepth(3002));
      buttonSounds(this, go);
      go.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); begin(); });
    };
    const begin = () => {
      if (this.mode.kind !== 'deploy' || this.overlayKind) return;
      for (const o of this.deployUi) o.destroy();
      this.deployUi = [];
      for (const [id, vow] of Object.entries(this.vowChoice)) if (vow) swearVow(this.state, id, vow);
      this.input.keyboard?.off('keydown-ENTER', begin);
      console.info('[oathbound] battle start', JSON.stringify({ seed, map: this.state.map.id, vows: this.vowChoice }));
      this.mode = { kind: 'busy' };
      playMusic(this, 'mus_battle_loop');
      // Oath bubbles (Writing): each sworn unit speaks its oath, staggered.
      let delay = 0;
      for (const [id, vow] of Object.entries(this.vowChoice)) {
        const line = vow ? lookup(`vows.${vow}.oath.${id}`) : undefined;
        if (typeof line === 'string') { this.time.delayedCall(delay, () => this.say(id, line, 1800)); delay += 2200; }
      }
      this.nextTurn();
    };
    this.input.keyboard?.on('keydown-ENTER', begin);
    playDialogue(this, scene('millFord.pre'), () => {
      // Next tick, so the key that closed the dialogue doesn't also press Begin.
      this.time.delayedCall(0, () => {
        this.mode = { kind: 'deploy' };
        this.refreshHint();
        this.redrawDeploy = draw;
        draw();
      });
    });
  }

  // ---------- map and units ----------

  private drawMap(): void {
    const { map } = this.state;
    for (const g of this.mapGfx) g.destroy();
    for (const g of this.overlays) g.destroy();
    this.mapGfx = [];
    this.overlays = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const t = tileAt(map, { x, y })!;
        const d0 = depthOf(this.iso, x, y) * 10;
        if (this.art) {
          this.drawTileArt(x, y, t.kind, t.height, d0);
          this.overlays.push(this.add.graphics().setDepth(d0 + 1));
          continue;
        }
        const g = this.add.graphics().setDepth(d0);
        this.mapGfx.push(g);
        const top = topDiamond(this.iso, x, y, t.height);
        const [n, e, s, w] = top as [Vec, Vec, Vec, Vec];
        const drop = t.height * this.iso.step + this.iso.step / 2;
        g.fillStyle(COLORS.tileLeft).fillPoints([w, s, { x: s.x, y: s.y + drop }, { x: w.x, y: w.y + drop }], true);
        g.fillStyle(COLORS.tileRight).fillPoints([s, e, { x: e.x, y: e.y + drop }, { x: s.x, y: s.y + drop }], true);
        const topColor = t.kind === 'water' ? COLORS.water : t.kind === 'ford' ? COLORS.ford : COLORS.tileTop[Math.min(t.height, 3)]!;
        g.fillStyle(topColor).fillPoints(top, true);
        g.lineStyle(1, 0x000000, 0.35).strokePoints([n, e, s, w], true);
        if (t.kind === 'boulder') {
          const c = tileCenter(this.iso, x, y, t.height);
          g.fillStyle(COLORS.boulder).fillEllipse(c.x, c.y - 8, 34, 26);
        }
        this.overlays.push(this.add.graphics().setDepth(d0 + 1));
      }
    }
  }

  private art = false;
  /** Token height above the tile centre, HP bar included: gray-box token 47 px, 2x sprite 62 px. */
  private get tokenH(): number { return this.art ? 62 : 47; }
  /** One tile column from the pack tileset: grass (or water / bridge) on top, dirt below, 8 art px per level. */
  private drawTileArt(x: number, y: number, kind: string, h: number, depth: number): void {
    const S = ART_SCALE;
    const c = tileCenter(this.iso, x, y, h);
    const left = c.x - this.iso.tileW / 2;
    const surfaceTop = c.y - this.iso.tileH / 2; // top corner of this tile's top diamond
    let side = 8 * (h + 1); // art px of side wall, as in the pixel-v1 drafts (h0 shows one half step)
    const top = kind === 'water' ? [TILE.waterFull, TILE.waterHalf] : kind === 'ford' ? [TILE.bridgeHalf, TILE.bridgeHalf] : [TILE.grassFull, TILE.grassHalf];
    // Top block first, then dirt down to the base; drawn bottom-up so upper blocks cover lower ones.
    const blocks: { frame: number; full: boolean; offset: number }[] = [];
    let offset = 0;
    let first = true;
    while (side > 0) {
      const full = side >= 16 && !(first && kind === 'ford');
      const frame = first ? (full ? top[0]! : top[1]!) : full ? TILE.dirtFull : TILE.dirtHalf;
      blocks.push({ frame, full, offset });
      const step = full ? 16 : 8;
      offset += step;
      side -= step;
      first = false;
    }
    for (const b of blocks.reverse()) {
      // Full blocks have their diamond at the cell top; half blocks 8 art px lower.
      const img = this.add.image(left, surfaceTop + b.offset * S - (b.full ? 0 : 8 * S), 'tileset', b.frame).setOrigin(0).setScale(S).setDepth(depth);
      this.mapGfx.push(img);
    }
    if (kind === 'boulder') {
      const rock = this.add.image(c.x, c.y + 6, 'tileset', TILE.rock).setOrigin(0.5, 1).setScale(S).setDepth(depth + 0.5);
      this.mapGfx.push(rock);
    }
  }

  private makeUnitView(u: Unit): UnitView {
    const root = this.add.container(0, 0);
    const body = this.add.graphics();
    const nub = this.add.graphics();
    const glyph = text(this, 0, -22, glyphFor(u), 14, '#111318').setOrigin(0.5);
    const hp = this.add.graphics();
    const sigil = this.add.graphics();
    const sigilText = text(this, -14, -68, '', 12, '#111318').setOrigin(0.5);
    root.add([nub, body, glyph, hp]);
    let sprite: Phaser.GameObjects.Sprite | null = null;
    let weapon: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image | null = null;
    const badge: Phaser.GameObjects.Text | null = null;
    const silhouette: Phaser.GameObjects.Sprite[] = [];
    if (this.art) {
      const look = unitLook(u);
      // 32x32 cell, feet at the bottom centre, 1 art px below the tile centre.
      sprite = this.add.sprite(0, 2, `${look.body}-attackSE`, 3).setOrigin(0.5, 1).setScale(ART_SCALE);
      // Weapon frames are 48x48 centred on the 32x32 body cell, so their bottom sits 8 art px lower.
      weapon = look.weapon === 'bow'
        ? this.add.image(10, -22, 'bow').setScale(ART_SCALE * 0.75)
        : this.add.sprite(0, 2 + 8 * ART_SCALE, `weapon-${look.weapon}SE`, 3).setOrigin(0.5, 1).setScale(ART_SCALE);
      // UX §5: no letter badges on the map; names live in the panels, timeline and Confirm.
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        silhouette.push(this.add.sprite(dx! * ART_SCALE, 2 + dy! * ART_SCALE, `${look.body}-attackSE`, 3).setOrigin(0.5, 1).setScale(ART_SCALE).setVisible(false));
      }
      root.addAt(silhouette, 1);
      root.addAt(sprite, 5);
      root.addAt(weapon, 6);
      glyph.setVisible(false);
    }
    const marker = this.add.graphics();
    root.add(marker);
    const outline = this.add.graphics().setDepth(898);
    const sigilRoot = this.add.container(0, 0, [sigil, sigilText]).setDepth(899);
    const view = { root, body, glyph, hp, nub, sigil, sigilText, outline, sigilRoot, sprite, weapon, badge, silhouette, marker };
    this.placeUnit(u, u.pos, view);
    return view;
  }

  private placeUnit(u: Unit, p: Point, view = this.views.get(u.id)): void {
    if (!view) return;
    const c = tileCenter(this.iso, p.x, p.y, heightAt(this.state.map, p));
    view.root.setPosition(c.x, c.y).setDepth(depthOf(this.iso, p.x, p.y) * 10 + 5);
    view.outline.setPosition(c.x, c.y);
    view.sigilRoot.setPosition(c.x, c.y);
  }

  /** Show a unit's pack pose, facing its current direction on screen. */
  private pose(u: Unit, v: UnitView, p: 'idle' | 'walk' | 'attack' | 'dead' | 'damage', dir?: Vec): void {
    if (!v.sprite) return;
    const look = unitLook(u);
    const { f, flip } = face(dir ?? screenDir(this.iso, DIRS[u.facing]));
    v.sprite.setFlipX(flip);
    const w = v.weapon;
    if (w) w.setFlipX(flip).setVisible(p === 'idle' || p === 'attack');
    if (w && look.weapon === 'bow') (w as Phaser.GameObjects.Image).setPosition(flip ? -10 : 10, f === 'NE' ? -26 : -22).setDepth(0);
    if (look.weapon === 'bow' && w) v.sprite.parentContainer?.moveTo(w, f === 'NE' ? 0 : 2);
    switch (p) {
      case 'walk': v.sprite.play(`${look.body}-walking${f}`, true); break;
      case 'attack':
        v.sprite.play(`${look.body}-attack${f}`);
        if (w instanceof Phaser.GameObjects.Sprite) w.play(`weapon-${look.weapon}${f}`);
        break;
      case 'dead': v.sprite.stop().setTexture(`${look.body}-dead${f}`, 0); break;
      case 'damage': v.sprite.stop().setTexture(`${look.body}-damage${f}`, 0); break;
      default:
        // Idle: the last attack frame, weapon held ready, so every unit shows what it carries.
        v.sprite.stop().setTexture(`${look.body}-attack${f}`, 3);
        if (w instanceof Phaser.GameObjects.Sprite) w.stop().setTexture(`weapon-${look.weapon}${f}`, 3);
    }
  }

  /** UX §5 team ring: 20x10 lp, 2 lp with a 1 lp dark edge; squad solid, Oathcourt in 4 arcs; a facing notch. */
  private drawRing(u: Unit, v: UnitView): void {
    const g = v.body;
    const col = u.team === 'player' ? FACTION.squad : FACTION.court;
    const rx = 20, ry = 10;
    const arc = (a0: number, a1: number, w: number, c: number) => {
      const pts: Phaser.Math.Vector2[] = [];
      for (let i = 0; i <= 12; i++) { const a = a0 + ((a1 - a0) * i) / 12; pts.push(new Phaser.Math.Vector2(Math.cos(a) * rx, Math.sin(a) * ry)); }
      g.lineStyle(w, c, 1).strokePoints(pts, false);
    };
    const spans: [number, number][] = u.team === 'player'
      ? [[0, Math.PI * 2]]
      // Gaps at E, S, W, N. The ellipse is flat, so the E/W gaps need a wider angle to show the same size.
      : [0, 1, 2, 3].map((q) => [q * (Math.PI / 2) + (q % 2 ? 0.25 : 0.55), (q + 1) * (Math.PI / 2) - (q % 2 ? 0.55 : 0.25)]);
    for (const [a0, a1] of spans) arc(a0, a1, 8, MARK.edge);
    for (const [a0, a1] of spans) arc(a0, a1, 4, col);
    if (u.status !== 'ok') return;
    const d = screenDir(this.iso, DIRS[u.facing]);
    const len = Math.hypot(d.x, d.y) || 1;
    const n = { x: d.x / len, y: d.y / len };
    const rim = { x: n.x * rx, y: n.y * ry };
    const tip = { x: rim.x + n.x * 8, y: rim.y + n.y * 6 };
    const side = { x: -n.y * 6, y: n.x * 6 };
    g.fillStyle(MARK.edge, 1).fillTriangle(tip.x + n.x * 2, tip.y + n.y * 2, rim.x + side.x * 1.4, rim.y + side.y * 1.4, rim.x - side.x * 1.4, rim.y - side.y * 1.4);
    g.fillStyle(col, 1).fillTriangle(tip.x, tip.y, rim.x + side.x, rim.y + side.y, rim.x - side.x, rim.y - side.y);
  }

  /** Keep the outline copies on the body's current texture, frame and flip. */
  private syncSilhouette(v: UnitView): void {
    if (!v.sprite || !v.silhouette[0]?.visible) return;
    for (const s of v.silhouette) {
      if (s.texture.key !== v.sprite.texture.key || s.frame.name !== v.sprite.frame.name) s.setTexture(v.sprite.texture.key, v.sprite.frame.name);
      s.setFlipX(v.sprite.flipX);
    }
  }

  update(time: number): void {
    const draw = this.targetMark?.getData('draw') as ((c: number) => void) | null;
    if (draw) {
      const f = Math.floor(time / 125) % CURSOR.pulse.length; // ~8 fps
      if (this.targetMark.getData('frame') !== f) { this.targetMark.setData('frame', f); draw(CURSOR.pulse[f]!); }
    }
    const bob = Math.floor(time / 400) % 2 ? -2 : 0; // active ▼: 2 frames, 400 ms (UX §4)
    for (const v of this.views.values()) {
      this.syncSilhouette(v);
      v.marker.setY(v.marker.getData('bob') ? bob : 0);
    }
  }

  private drawUnit(u: Unit): void {
    const v = this.views.get(u.id);
    if (!v) return;
    if (u.status === 'lost') {
      // Death animation (#20): sink and fade out over ~400 ms, then leave the board.
      v.outline.clear();
      if (v.root.visible && !this.tweens.isTweening(v.root)) {
        if (v.sprite) {
          // Pack death: hit frame, then the lying frame, then fade out.
          v.body.clear(); v.hp.clear(); v.nub.clear(); v.badge?.setVisible(false);
          this.pose(u, v, 'damage');
          this.time.delayedCall(200, () => this.pose(u, v, 'dead'));
          this.tweens.add({ targets: v.root, alpha: 0, duration: 400, delay: 550, onComplete: () => v.root.setVisible(false) });
        } else {
          this.tweens.add({ targets: v.root, alpha: 0, y: v.root.y + 10, duration: 400, delay: 250, onComplete: () => v.root.setVisible(false) });
        }
      }
      return;
    }
    v.root.setVisible(true).setAlpha(1);
    v.outline.clear();
    const edge = u.team === 'player' ? COLORS.player : COLORS.enemy;
    if (u.status === 'downed') v.outline.lineStyle(1, edge, 0.6).strokeEllipse(0, -4, 30, 12);
    else v.outline.lineStyle(1, edge, 0.6).strokeRoundedRect(-13, -38, 26, 36, 5);
    const color = u.status === 'downed' ? COLORS.downed : u.team === 'player' ? COLORS.player : COLORS.enemy;
    const active = this.state.activeId === u.id;
    const lit = this.hoverUnitId === u.id;
    v.body.clear();
    if (v.sprite) {
      // Faction ring under the feet (Director): crimson for the Oathcourt, steel blue for the squad,
      // 2 art px thick, about 20x8 art px. Gold outer ring for the active unit, pale for hover.
      this.drawRing(u, v);
      this.pose(u, v, u.status === 'downed' ? 'dead' : 'idle');
      // Sprite outline (UX §4): the selected target in red-orange wins over hover in bone.
      const sel = this.mode.kind === 'target' ? this.mode.selected : undefined;
      const targeted = !!sel && samePoint(sel, u.pos);
      const tint = targeted ? MARK.target : lit || active ? MARK.bone : null;
      for (const s of v.silhouette) s.setVisible(tint !== null && u.status === 'ok').setTintFill(tint ?? 0xffffff);
      this.syncSilhouette(v);
      v.marker.clear();
      if (u.status === 'ok' && (targeted || active)) {
        const y = -(this.tokenH + 14);
        const col = targeted ? MARK.target : MARK.bone;
        v.marker.fillStyle(MARK.edge, 1).fillTriangle(-8, y - 2, 8, y - 2, 0, y + 10);
        v.marker.fillStyle(col, 1).fillTriangle(-6, y, 6, y, 0, y + 7);
      }
      v.marker.setData('bob', active && !targeted);
    } else if (u.status === 'downed') {
      v.body.fillStyle(color).fillEllipse(0, -4, 30, 12);
      v.glyph.setY(-4).setText('☠');
    } else {
      v.body.fillStyle(color).fillRoundedRect(-13, -38, 26, 36, 5);
      v.body.lineStyle(active || lit ? 3 : 1, active ? COLORS.gold : lit ? COLORS.hover : 0x000000, 1).strokeRoundedRect(-13, -38, 26, 36, 5);
      v.glyph.setY(-20).setText(glyphFor(u));
    }
    v.nub.clear();
    if (u.status === 'ok' && !v.sprite) {
      const d = screenDir(this.iso, DIRS[u.facing]);
      v.nub.fillStyle(0xffffff, 0.9).fillTriangle(d.x * 22, d.y * 22, d.x * 10 - d.y * 8, d.y * 10 + d.x * 4, d.x * 10 + d.y * 8, d.y * 10 - d.x * 4);
    }
    this.drawSigil(u, v);
    v.hp.clear();
    if (u.status !== 'ok') return;
    const frac = Math.max(0, u.hp / u.base.hp);
    const hy = -(this.tokenH - 1);
    if (v.sprite) {
      // UX §5: 20x3 lp with a 1 lp dark edge, filled in the team colour.
      v.hp.fillStyle(MARK.edge, 1).fillRect(-22, hy - 2, 44, 10);
      v.hp.fillStyle(0x3a3631, 1).fillRect(-20, hy, 40, 6);
      v.hp.fillStyle(u.team === 'player' ? FACTION.squadHp : FACTION.court, 1).fillRect(-20, hy, Math.round(40 * frac), 6);
      return;
    }
    v.hp.fillStyle(0x000000, 0.7).fillRect(-15, hy, 30, 5);
    v.hp.fillStyle(frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfacc15 : 0xef4444).fillRect(-15, hy, 30 * frac, 5);
  }

  /** Sigil boxes placed in the current refresh, in world space. */
  private placedSigils: Phaser.Geom.Rectangle[] = [];

  private sigilSpot(u: Unit): Vec {
    const base = u.status === 'downed' ? -26 : -(this.tokenH + 21);
    const candidates: Vec[] = [{ x: -14, y: base }, { x: 14, y: base }, { x: 0, y: base - 6 }, { x: -24, y: base + 6 }, { x: 24, y: base + 6 }, { x: -33, y: base + 12 }, { x: 33, y: base + 12 }, { x: 0, y: base - 26 }];
    const me = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
    const others = this.state.units.filter((o) => o.id !== u.id && o.status !== 'lost').map((o) => {
      const c = tileCenter(this.iso, o.pos.x, o.pos.y, heightAt(this.state.map, o.pos));
      const dx = c.x - me.x;
      const dy = c.y - me.y;
      // Token body plus HP bar (or the flat downed marker), relative to this unit.
      return o.status === 'downed' ? new Phaser.Geom.Rectangle(dx - 15, dy - 10, 30, 12) : new Phaser.Geom.Rectangle(dx - 15, dy - this.tokenH, 30, this.tokenH);
    });
    // Other units' placed sigils, moved into this unit's local space.
    for (const q of this.placedSigils) others.push(new Phaser.Geom.Rectangle(q.x - me.x, q.y - me.y, q.width, q.height));
    const box = (p: Vec) => new Phaser.Geom.Rectangle(p.x - 14, p.y - 14, 28, 36); // diamond plus pips
    const overlap = (p: Vec) => others.reduce((sum, r) => {
      const i = Phaser.Geom.Rectangle.Intersection(r, box(p));
      return sum + (i.width > 0 && i.height > 0 ? i.width * i.height : 0);
    }, 0);
    // First free spot; if none is free (4+ units packed round one tile), the one covering least.
    const spot = candidates.find((p) => overlap(p) === 0) ?? candidates.reduce((a, b) => (overlap(b) < overlap(a) ? b : a));
    const b = box(spot);
    this.placedSigils.push(new Phaser.Geom.Rectangle(b.x + me.x, b.y + me.y, b.width, b.height));
    return spot;
  }

  /** Vow sigil (UX board 4): gold while intact or kept, cracked violet when broken, dim when frozen or lapsed. */
  private drawSigil(u: Unit, v: UnitView): void {
    v.sigil.clear();
    const vow = this.state.vows[u.id];
    if (!vow || u.status === 'lost') { v.sigilText.setText(''); return; }
    // Above the token, at the first spot that covers no other unit's token or HP bar (QA #16, #27).
    // Offsets are in screen space, so this is re-checked at every rotation.
    const { x, y } = this.sigilSpot(u);
    const dim = vow.status === 'lapsed';
    // v1.7 "Held": goal met but still breakable until battle end (UX sigil board).
    const held = vow.status === 'intact' && vow.progress >= vow.goal;
    // Frozen (unit downed with the vow intact): last state at 40% with a pause bar; nothing can break it.
    const frozen = vow.frozen && vow.status === 'intact';
    const color = vow.status === 'broken' ? COLORS.violet : dim ? COLORS.downed : held ? 0xf3e3b5 : COLORS.gold;
    const d = [{ x, y: y - 14 }, { x: x + 14, y }, { x, y: y + 14 }, { x: x - 14, y }];
    v.sigil.setAlpha(frozen ? 0.4 : 1);
    v.sigilText.setAlpha(frozen ? 0.4 : 1);
    // Leader line to the owner's head, so a sigil that had to move aside still reads as this unit's.
    if (u.status === 'ok' && (x !== 0 || y < -(this.tokenH + 27))) {
      v.sigil.lineStyle(4, 0x000000, 0.8).lineBetween(x, y + 14, 0, -this.tokenH);
      v.sigil.lineStyle(2, color, 1).lineBetween(x, y + 14, 0, -this.tokenH);
    }
    v.sigil.fillStyle(color, 1).fillPoints(d, true);
    if (frozen) v.sigil.fillStyle(0xe5e7eb, 1).fillRect(x + 12, y - 12, 2, 7).fillRect(x + 16, y - 12, 2, 7);
    if (held) {
      // Dashed inner ring.
      for (let i = 0; i < 12; i += 2) {
        const a0 = (i / 12) * Math.PI * 2;
        const a1 = ((i + 1) / 12) * Math.PI * 2;
        v.sigil.lineStyle(1.5, 0x8a6d1f, 1).lineBetween(x + Math.cos(a0) * 8, y + Math.sin(a0) * 8, x + Math.cos(a1) * 8, y + Math.sin(a1) * 8);
      }
    }
    v.sigil.lineStyle(2, 0x000000, 0.85).strokePoints(d, true);
    if (vow.status === 'broken') {
      v.sigil.lineStyle(2, 0x1e1b4b, 1).lineBetween(x - 5, y - 10, x + 2, y - 1).lineBetween(x + 2, y - 1, x - 2, y + 4).lineBetween(x - 2, y + 4, x + 5, y + 10);
      v.sigilText.setText('');
    } else {
      // UX §5: progress lives in the unit panel and the sigil tooltip; the map keeps the diamond, pips and ✓.
      v.sigilText.setPosition(x, y).setText(vow.status === 'fulfilled' ? '✓' : this.art ? '' : `${vow.progress}/${vow.goal}`);
    }
    // Pips (UX): one per goal step, filled as progress grows.
    for (let i = 0; i < vow.goal && vow.status !== 'broken'; i++) {
      const px = x + (i - (vow.goal - 1) / 2) * 8;
      v.sigil.fillStyle(i < vow.progress ? color : 0x000000, i < vow.progress ? 1 : 0.7).fillCircle(px, y + 19, 3);
    }
  }

  // ---------- HUD (UX readability §8: laid out in lp on a W x H screen, GUI pieces at 1 lp) ----------

  /** Everything buildHud made, destroyed and rebuilt when the logical screen size changes. */
  private hudObjs: Phaser.GameObjects.GameObject[] = [];
  /** Camera cluster rect in lp; the board ignores clicks there. */
  private camRect = { x: 0, y: 0, w: 0, h: 0 };
  private compassAt = { x: 0, y: 0 };
  private hoverBtn = -1;

  private buildHud(): void {
    for (const o of this.hudObjs) o.destroy();
    this.hudObjs = [];
    for (const b of this.buttons) b.destroy();
    this.buttons = [];
    const before = new Set(this.children.list);
    const { w: W, h: H } = screenLp();

    // Top left: Menu and Help, then the battle log.
    this.hudButton(4, 4, 24, { key: 'gui-options', glyph: '≡', tip: 'Menu (Esc): volume, restart, quit', fn: () => this.openOverlay('pause') });
    this.hudButton(32, 4, 24, { key: 'gui-help', glyph: '?', tip: 'Help (H): every key and control', fn: () => this.openOverlay('help') });
    this.logText = text(this, X(4), X(32), '', 14).setDepth(1000).setWordWrapWidth(X(166)).setBackgroundColor('#1f1e1bb0').setPadding(X(2), X(1), X(2), X(1));
    this.debugText = text(this, X(4), X(32), '', 14, '#a7f3d0').setDepth(1001).setBackgroundColor('#000000cc').setVisible(this.debug);

    // Top right: morale. Top centre: the turn timeline.
    this.moraleText = text(this, X(W - 4), X(4), '', 14).setOrigin(1, 0).setAlign('right').setDepth(1000)
      .setBackgroundColor('#1f1e1bb0').setPadding(X(2), X(1), X(2), X(1)).setInteractive();
    this.moraleText.on('pointerover', () => {
      const tier = teamMorale(this.state, 'player').name.toLowerCase();
      this.setHint(`${t(`ui.morale.${tier}.name`)}: ${t(`ui.morale.${tier}.tooltip`, moraleParams(tier))}`);
    });
    this.moraleText.on('pointerout', () => this.refreshHint());
    this.timeline = this.add.container(0, 0).setDepth(1000);

    // Hint plate, bottom edge at H - 100, centred; it grows upward for a long tooltip.
    this.hintPlate = this.add.rectangle(X(W / 2), X(H - 100), X(220), X(13), MARK.edge, 0.75).setOrigin(0.5, 1).setDepth(999);
    this.hint = text(this, X(W / 2), X(H - 101.5), '', 14, BONE).setOrigin(0.5, 1).setAlign('center').setDepth(1000);

    // Bottom row: unit panel, action panel, target panel.
    this.hudBox(4, H - 96, 176, 92);
    this.unitTitle = text(this, X(12), X(H - 89), '', 32, BONE).setDepth(1000);
    this.unitClass = text(this, X(170), X(H - 83), '', 14, COLORS.textDim).setOrigin(1, 0).setDepth(1000);
    this.unitHp = text(this, X(12), X(H - 71), '', 14).setDepth(1000);
    this.unitHpBar = this.add.graphics().setDepth(1000);
    this.unitBody = text(this, X(12), X(H - 62), '', 14).setDepth(1000).setWordWrapWidth(X(160)).setMaxLines(4);
    this.unitVow = this.add.graphics().setDepth(1000);
    this.unitVowText = text(this, X(29), 0, '', 14).setOrigin(0, 0.5).setDepth(1000);

    const ax = W / 2 - 136;
    this.hudBox(ax, H - 96, 272, 92);
    this.actionHead = text(this, X(ax + 10), X(H - 88), '', 14, COLORS.textDim).setDepth(1000);
    text(this, X(ax + 10), X(H - 23), '1-6 act   Tab next   Enter ok   Esc back', 14, '#8c8981').setDepth(1000);

    const tx = W - 180;
    this.hudBox(tx, H - 96, 176, 92);
    const px = X(tx + 10);
    this.pv = {
      head: text(this, px, X(H - 82), '', 14, BONE).setOrigin(0, 0.5).setDepth(1000),
      name: text(this, px, 0, '', 14).setDepth(1000),
      big: text(this, px, 0, '', 32, BONE).setDepth(1000),
      detail: text(this, px, 0, '', 14, COLORS.textDim).setDepth(1000),
      value: text(this, px, 0, '', 14).setDepth(1000),
      body: text(this, px, 0, '', 14).setDepth(1000).setWordWrapWidth(X(156)),
      strip: this.add.rectangle(X(tx + 8), X(H - 39), X(160), X(11), 0x5b1f17).setOrigin(0).setDepth(1000),
      stripText: text(this, px + X(1), X(H - 29.5), '', 14, BONE).setOrigin(0, 0.5).setDepth(1001),
      empty: text(this, X(tx + 88), X(H - 50), 'Hover a unit to see it here', 14, '#8c8981').setOrigin(0.5).setDepth(1000),
    };
    // Confirm (UX §2, §8): 160 x 16, bone primary, drawn in code so it stays on the 1 lp grid.
    const cbg = this.add.rectangle(X(tx + 8), X(H - 26), X(160), X(16), MARK.bone).setOrigin(0).setStrokeStyle(X(1), MARK.edge).setDepth(1000).setInteractive({ useHandCursor: true });
    const clabel = text(this, X(tx + 88), X(H - 18), '', 14, DARK).setOrigin(0.5).setDepth(1001);
    cbg.on('pointerover', () => cbg.setFillStyle(0xf7f2e6).setStrokeStyle(X(1), MARK.edge));
    cbg.on('pointerout', () => cbg.setFillStyle(MARK.bone).setStrokeStyle(X(1), MARK.edge));
    cbg.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); sfx(this, 'ui_click'); this.confirmTarget(); });
    this.confirm = { bg: cbg, label: clabel };
    this.targetArrows = ([[-1, 'gui-left', '◀', W - 46], [1, 'gui-right', '▶', W - 28]] as const).map(([dir, key, glyph, x]) =>
      this.hudButton(x, H - 90, 16, { key, glyph, tip: dir < 0 ? 'Previous target (Shift+Tab)' : 'Next target (Tab)', fn: () => this.cycleTarget(dir) }));

    // Camera cluster on a 9-slice C plate above the target panel: rotate, compass, rotate | zoom out, zoom in, centre.
    this.camRect = { x: W - 134, y: H - 128, w: 130, h: 28 };
    const c = this.camRect;
    this.hudBox(c.x, c.y, c.w, c.h, 'plate');
    const by = c.y + 6;
    this.hudButton(c.x + 6, by, 16, { key: 'gui-rotl', glyph: '⟲', tip: t('ui.camera.rotateLeft'), fn: () => this.rotateView(-1) });
    this.compassAt = { x: X(c.x + 36), y: X(c.y + 14) };
    this.compass = this.add.graphics().setDepth(1000);
    this.compassLabel = text(this, 0, 0, 'N', 14, '#c0533f').setOrigin(0.5).setDepth(1001).setStroke(DARK, X(1));
    this.hudButton(c.x + 50, by, 16, { key: 'gui-rotr', glyph: '⟳', tip: t('ui.camera.rotateRight'), fn: () => this.rotateView(1) });
    this.hudButton(c.x + 74, by, 16, { key: 'gui-less', glyph: '−', tip: `${t('ui.camera.zoomOut')} (-)`, fn: () => this.zoomStep(-1) });
    this.hudButton(c.x + 92, by, 16, { key: 'gui-more', glyph: '+', tip: `${t('ui.camera.zoomIn')} (+)`, fn: () => this.zoomStep(1) });
    this.hudButton(c.x + 110, by, 16, { key: 'gui-centre', glyph: '◎', tip: `${t('ui.camera.center')} (C)`, fn: () => this.centerOnActive(true) });
    this.drawCompass();

    this.hudObjs = this.children.list.filter((o) => !before.has(o));
    this.rebuildButtons();
  }

  /** A framed HUD box: 9-slice B panel or C plate at 1 lp, with a plain rectangle under it as the canvas fallback. */
  private hudBox(x: number, y: number, w: number, h: number, kind: 'panel' | 'plate' = 'panel'): void {
    const r = this.add.rectangle(X(x), X(y), X(w), X(h), COLORS.panel, 0.94).setOrigin(0).setStrokeStyle(X(1), COLORS.panelEdge).setDepth(999);
    const s = kind === 'panel' ? hudPanel(this, X(x), X(y), w, h) : hudPlate(this, X(x), X(y), w, h);
    if (s) { s.setDepth(999); r.setVisible(false); }
  }

  /**
   * A small HUD button at (x, y) lp, `size` lp square. With a sheet key it uses the pack's frames
   * (0 rest, 1 hover, 2 pressed, 3 disabled); otherwise it is drawn in code: dark square, bone glyph.
   */
  private hudButton(x: number, y: number, size: number, o: { key?: string; glyph: string; tip: string; fn: () => void }): Phaser.GameObjects.GameObject {
    const img = o.key ? hudImage(this, X(x), X(y), o.key, 0) : null;
    let hit: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
    let glyph: Phaser.GameObjects.Text | null = null;
    if (img) hit = img;
    else {
      hit = this.add.rectangle(X(x), X(y), X(size), X(size), MARK.edge).setOrigin(0).setStrokeStyle(X(1), 0x5a5347);
      glyph = text(this, X(x + size / 2), X(y + size / 2), o.glyph, size > 20 ? 32 : 14, BONE).setOrigin(0.5).setDepth(1001);
    }
    hit.setDepth(1000).setInteractive({ useHandCursor: true });
    // Frame 1 of the 16 px sheets is green; green is kept for HP only (Art), so they light with frame 2.
    const lit = size === 16 ? 2 : 1;
    const look = (f: number) => {
      if (img) img.setFrame(img.getData('off') ? 3 : f === 1 ? lit : f);
      else (hit as Phaser.GameObjects.Rectangle).setFillStyle(f ? 0x3a3631 : MARK.edge).setStrokeStyle(X(1), f ? COLORS.gold : 0x5a5347);
    };
    hit.on('pointerover', () => { look(1); sfx(this, 'ui_hover'); this.setHint(o.tip); });
    hit.on('pointerout', () => { look(0); this.refreshHint(); });
    hit.on('pointerup', () => look(1));
    hit.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
      ev.stopPropagation();
      look(2);
      sfx(this, 'ui_click');
      o.fn();
    });
    if (glyph) hit.once('destroy', () => glyph!.destroy());
    if (glyph) hit.setData('glyph', glyph);
    return hit;
  }

  private setHint(s: string): void {
    const { w: W } = screenLp();
    this.hint.setWordWrapWidth(X(W - 2 * 138 - 12)).setMaxLines(3).setText(s);
    const w = Math.max(X(220), this.hint.width + X(12));
    this.hintPlate.setSize(w, Math.max(X(13), this.hint.height + X(3))).setOrigin(0.5, 1).setVisible(!!s);
    this.hint.setVisible(!!s);
  }

  /** Last log lines from the past 4 s, at most 3 wrapped lines (UX §8). */
  private renderLog(): void {
    if (!this.logText?.active) return;
    const now = this.time.now;
    let shown: string[] = [];
    for (let i = this.log.length - 1; i >= 0; i--) {
      if (now - (this.logTimes[i] ?? 0) > 4000) break;
      const next = [this.log[i]!, ...shown];
      if (this.logText.getWrappedText(next.join('\n')).length > 3) break;
      shown = next;
    }
    this.logText.setText(shown.join('\n')).setVisible(!this.debug && shown.length > 0);
  }

  // ---------- pause and help overlays ----------

  private overlay: Phaser.GameObjects.GameObject[] = [];
  private overlayKind: 'pause' | 'help' | null = null;
  /** Pause menu rows and the focused one (UX #47 review: bone 2 lp outline, Resume by default). */
  private pauseRows: { focus: () => void; press: () => void }[] = [];
  private pauseFocus = 0;

  private closeOverlay(): void {
    for (const o of this.overlay) o.destroy();
    this.overlay = [];
    this.overlayKind = null;
    this.pauseRows = [];
    this.pauseFocus = 0;
  }

  private openOverlay(kind: 'pause' | 'help'): void {
    this.closeOverlay();
    this.overlayKind = kind;
    const before = new Set(this.children.list);
    const { w: W, h: H } = screenLp();
    const stop = (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => ev.stopPropagation();
    const shade = this.add.rectangle(0, 0, X(W), X(H), 0x000000, 0.55).setOrigin(0).setDepth(2900).setInteractive();
    shade.on('pointerdown', (p: Phaser.Input.Pointer, x: number, y: number, ev: Phaser.Types.Input.EventData) => { stop(p, x, y, ev); this.closeOverlay(); });
    const pw = kind === 'help' ? 300 : 150;
    const ph = kind === 'help' ? 168 : 110;
    const px = Math.round(W / 2 - pw / 2), py = Math.round(H / 2 - ph / 2);
    const back = this.add.rectangle(X(px), X(py), X(pw), X(ph), COLORS.panel, 0.98).setOrigin(0).setStrokeStyle(X(1), COLORS.gold).setDepth(2901).setInteractive();
    back.on('pointerdown', stop);
    const frame = hudPanel(this, X(px), X(py), pw, ph);
    if (frame) { frame.setDepth(2901.5); back.setStrokeStyle(); }
    text(this, X(px + 12), X(py + 8), kind === 'help' ? 'Controls' : 'Paused', 32, BONE).setDepth(2902);
    if (kind === 'help') {
      const left = ['Click: move, select, confirm', 'Right-click / Esc: back', '1-6: actions   W: wait', 'Tab / Shift+Tab: next target', 'Enter / Space: confirm', 'Arrows: facing after acting'];
      const right = ['Drag, arrows: pan', 'Wheel, + / -: zoom', 'Q / E: rotate', 'C: centre on unit', 'R / Home: reset view', 'M: mute   D: debug   H: help'];
      text(this, X(px + 12), X(py + 30), left.join('\n'), 14).setDepth(2902).setLineSpacing(X(3));
      text(this, X(px + 156), X(py + 30), right.join('\n'), 14).setDepth(2902).setLineSpacing(X(3));
      text(this, X(px + pw / 2), X(py + ph - 20), 'Click anywhere or Esc to close', 14, COLORS.textDim).setOrigin(0.5, 0).setDepth(2902);
    } else {
      const items: [() => string, () => void][] = [
        [() => 'Resume', () => this.closeOverlay()],
        [() => volumeLabel().replace('♪', 'Music'), () => { cycleVolume(this); }],
        [() => 'Restart battle', () => { this.closeOverlay(); this.scene.restart(); }],
        [() => 'Back to title', () => { this.closeOverlay(); this.scene.start('Menu'); }],
      ];
      const ring = this.add.graphics().setDepth(2904);
      this.pauseRows = items.map(([label, fn], i) => {
        const y = py + 30 + i * 16;
        const row = this.add.rectangle(X(px + 10), X(y), X(pw - 20), X(14), MARK.edge, 0.6).setOrigin(0).setDepth(2902).setInteractive({ useHandCursor: true });
        const tx = text(this, X(px + 18), X(y + 7), label(), 14, BONE).setOrigin(0, 0.5).setDepth(2903);
        const focus = () => {
          this.pauseFocus = i;
          ring.clear().lineStyle(X(2), MARK.bone, 1).strokeRect(X(px + 9), X(y - 1), X(pw - 18), X(16));
        };
        const press = () => { sfx(this, 'ui_click'); fn(); if (tx.active) tx.setText(label()); };
        row.on('pointerover', () => { if (this.pauseFocus !== i) sfx(this, 'ui_hover'); focus(); });
        row.on('pointerdown', (p: Phaser.Input.Pointer, x: number, yy: number, ev: Phaser.Types.Input.EventData) => { stop(p, x, yy, ev); press(); });
        return { focus, press };
      });
      this.pauseRows[0]!.focus();
    }
    this.overlay = this.children.list.filter((o) => !before.has(o));
  }

  private rebuildButtons(): void {
    for (const b of this.buttons) b.destroy();
    this.buttons = [];
    const u = activeUnit(this.state);
    this.actionHead.setText(u && u.team === 'player' ? `${u.name} · actions` : u ? `${u.name} is acting` : '');
    if (!u || u.team !== 'player') return;
    const { w: W, h: H } = screenLp();
    const ids = u.abilities.filter((id) => ABILITIES[id]?.type !== 'passive');
    ids.push('wait');
    ids.forEach((id, i) => {
      // 3 x 2 grid of 82 x 22 tabs, 5 lp column gap and 4 lp row gap (UX §8).
      const x = X(W / 2 - 128 + (i % 3) * 87);
      const y = X(H - 77 + Math.floor(i / 3) * 26);
      const bg = this.add.rectangle(x, y, X(82), X(22), 0x1f2937).setOrigin(0).setStrokeStyle(X(1), COLORS.panelEdge).setDepth(1000).setInteractive({ useHandCursor: true });
      const skin = hudTab(this, x, y, 82);
      if (skin) { skin.setDepth(1000); bg.setFillStyle(0x000000, 0).setStrokeStyle(); }
      const ring = this.add.graphics().setDepth(1001);
      const label = text(this, x + X(6), y + X(10), '', 14).setOrigin(0, 0.5).setDepth(1001);
      const cd = text(this, x + X(70), y + X(10), '', 14).setOrigin(1, 0.5).setDepth(1001);
      bg.on('pointerover', () => { sfx(this, 'ui_hover'); this.hoverBtn = i; this.refreshButtons(); });
      bg.on('pointerout', () => { this.hoverBtn = -1; this.refreshButtons(); this.refreshHint(); });
      bg.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); this.pressAction(i); });
      if (id !== 'wait') bg.on('pointerover', () => this.setHint(`${abilityLabel(id)}: ${t(`ui.abilities.${id}.tooltip`, abilityParams(id, effectiveStats(this.state, u).mag))}`));
      else bg.on('pointerover', () => this.setHint('Wait or end the turn, then choose a facing (W)'));
      const destroy = () => { for (const o of [bg, skin, ring, label, cd]) o?.destroy(); };
      this.buttons.push({ id, bg, label, cd, ring, skin, destroy });
    });
    this.refreshButtons();
  }

  private refreshButtons(): void {
    const u = activeUnit(this.state);
    this.buttons.forEach((b, i) => {
      let enabled = this.mode.kind === 'move' || this.mode.kind === 'target';
      let suffix = '';
      if (b.id !== 'wait' && u) {
        const cd = u.cooldowns[b.id] ?? 0;
        if (cd > 0) suffix = `CD ${cd}`;
        if (u.usedOnce.includes(b.id)) suffix = 'used';
        enabled &&= !this.state.acted && abilityReady(u, b.id) && targetTiles(this.state, u, b.id).length > 0;
      }
      const selected = this.mode.kind === 'target' && this.mode.abilityId === b.id;
      const name = b.id === 'wait' ? (this.state.moved || this.state.acted ? t('ui.turn.endTurn') : t('ui.turn.wait')) : abilityShort(b.id);
      b.label.setText(`${selected ? '▶' : i + 1} ${name}`);
      b.cd.setText(suffix);
      // A long label drops its key number rather than shrink (pixel fonts come in whole sizes only).
      const room = X(82 - 6 - 12) - (suffix ? b.cd.width + X(3) : 0);
      if (b.label.width > room) b.label.setText(selected ? `▶${name}` : name);
      const frame: TabFrame = !enabled ? 3 : selected || this.hoverBtn === i ? 2 : 0; // frame 1 is green (Art: no green but HP)
      if (b.skin) {
        setTabFrame(b.skin, frame);
        const col = enabled ? DARK : '#8c8981';
        b.label.setColor(col);
        b.cd.setColor(col);
      } else {
        b.bg.setFillStyle(selected ? 0x374151 : 0x1f2937).setStrokeStyle(X(1), selected ? COLORS.gold : COLORS.panelEdge);
        b.label.setColor(enabled ? COLORS.text : '#4b5563');
        b.cd.setColor(COLORS.textDim);
      }
      // Selected: a 2 lp bone outline with a 1 lp dark edge (UX §4, §8).
      b.ring.clear();
      if (selected) {
        const { x, y } = b.bg;
        b.ring.lineStyle(X(1), MARK.edge, 1).strokeRect(x - X(2.5), y - X(2.5), X(87), X(27));
        b.ring.lineStyle(X(2), MARK.bone, 1).strokeRect(x - X(1), y - X(1), X(84), X(24));
      }
    });
  }

  private refreshTimeline(): void {
    this.timeline.removeAll(true);
    const { w: W } = screenLp();
    const active = this.state.activeId ?? undefined;
    const entries = forecast(this.state.units, 8, active);
    const x0 = W / 2 - 172;
    this.timeline.add(text(this, X(x0 + 12), X(20), 'NEXT', 14, COLORS.textDim).setOrigin(0.5).setStroke(DARK, X(1)));
    const sel = this.mode.kind === 'target' ? this.mode.selected : undefined;
    const targetId = sel ? occupant(this.state, sel)?.id : undefined;
    entries.forEach((e, i) => {
      const u = getUnit(this.state, e.unitId);
      const cx = x0 + 24 + i * 40 + 4;
      const lit = this.hoverUnitId === u.id;
      const out = e.downed || u.status !== 'ok';
      const team = u.team === 'player' ? FACTION.squadHp : FACTION.court;
      const chip = hudImage(this, X(cx), X(4), `gui-chip-${out ? 3 : lit ? 2 : 0}`);
      const hit = chip ?? this.add.rectangle(X(cx), X(4), X(32), X(32), u.team === 'player' ? 0x0c4a6e : 0x7f1d1d).setOrigin(0).setStrokeStyle(X(1), lit ? COLORS.hover : COLORS.panelEdge);
      hit.setInteractive({ useHandCursor: true });
      hit.on('pointerover', () => { this.hoverUnitId = u.id; this.refreshUnits(); this.refreshTimeline(); });
      hit.on('pointerout', () => { this.hoverUnitId = null; this.refreshUnits(); this.refreshTimeline(); });
      // Clicking a chip points at that unit's tile, so units hidden on the board can still be targeted.
      hit.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation();
        if (u.status === 'lost') return;
        // In targeting a chip only selects (UX §3); it never confirms, even on the current selection (QA #43).
        if (this.mode.kind === 'target') {
          const a = activeUnit(this.state);
          if (a && targetTiles(this.state, a, this.mode.abilityId).some((p) => samePoint(p, u.pos))) this.selectTarget(u.pos, true);
          return;
        }
        this.setHover({ ...u.pos });
        this.panTo(u.pos);
      });
      this.timeline.add(hit);
      // Dark faction fill (Art): squad #28456A, Oathcourt #681F27, then the portrait and the 3 lp band.
      this.timeline.add(this.add.rectangle(X(cx + 3), X(4 + 3), X(26), X(26), out ? 0x2e2c2a : u.team === 'player' ? 0x28456a : 0x681f27).setOrigin(0));
      // Portrait: walk frame 0 facing SE, head and shoulders, 1 lp clear above the hair.
      const key = `${unitLook(u).body}-walkingSE`;
      if (this.art && this.textures.exists(key)) {
        const img = this.add.image(X(cx), X(4 + 3), key, 0).setOrigin(0).setScale(LP).setCrop(3, 0, 26, 23);
        if (out) img.setTint(0x6b6b6b);
        this.timeline.add(img);
      } else {
        this.timeline.add(text(this, X(cx + 16), X(18), glyphFor(u), 14).setOrigin(0.5));
      }
      this.timeline.add(this.add.rectangle(X(cx + 3), X(4 + 26), X(26), X(3), out ? 0x4b4b4b : team).setOrigin(0));
      const ring = i === 0 ? MARK.bone : u.id === targetId ? MARK.target : null;
      if (ring !== null) {
        const g = this.add.graphics();
        g.lineStyle(X(1), MARK.edge, 1).strokeRect(X(cx - 2.5), X(1.5), X(37), X(37));
        g.lineStyle(X(2), ring, 1).strokeRect(X(cx - 1), X(3), X(34), X(34));
        this.timeline.add(g);
      }
      let name = `${e.downed ? '☠' : ''}${shortName(u)}`;
      const label = text(this, X(cx + 16), X(37), name, 14).setOrigin(0.5, 0).setStroke(DARK, X(1));
      while (label.width > X(39) && name.length > 2) { name = name.slice(0, -1); label.setText(`${name}.`); }
      this.timeline.add(label);
    });
    // Wait ghost (UX board): where the active unit would land if it waited (CT 40).
    const a = activeUnit(this.state);
    if (a && a.team === 'player' && !this.state.moved && !this.state.acted) {
      const ghost = forecast(this.state.units, 8, a.id, 40).findIndex((e, i) => i > 0 && e.unitId === a.id);
      if (ghost > 0) {
        const gx = x0 + 24 + ghost * 40 + 20;
        this.timeline.add(text(this, X(gx), X(47), `▲ ${t('ui.timeline.waitGhost')}`, 14, '#f5c451').setOrigin(0.5, 0).setStroke(DARK, X(1)));
      }
    }
  }

  private refreshMorale(): void {
    const p = this.state.morale.player;
    const e = this.state.morale.enemy;
    const tier = (team: 'player' | 'enemy') => t(`ui.morale.${teamMorale(this.state, team).name.toLowerCase()}.name`);
    this.moraleText.setText(`${t('ui.morale.squad')} ${t('ui.morale.label').toLowerCase()} ${p} ${tier('player')}\n${t('ui.morale.foe').padEnd(t('ui.morale.squad').length)} ${t('ui.morale.label').toLowerCase()} ${e} ${tier('enemy')}`);
    // Bark once when squad morale enters Shaken.
    const shaken = teamMorale(this.state, 'player').name === 'Shaken';
    if (shaken && !this.wasShaken) {
      const speaker = this.state.units.find((u) => u.team === 'player' && u.status === 'ok');
      if (speaker) this.barkFor(speaker.id, 'shaken', true);
    }
    this.wasShaken = shaken;
  }

  private className(u: Unit): string {
    const cls = u.classId ? CLASSES[u.classId]!.name : u.leader ? 'Leader' : 'Oathcourt';
    return u.status !== 'ok' ? `${u.status.toUpperCase()} (${u.reviveCounter})` : cls;
  }

  /** Stat rows shared by the unit panel and the hover card. */
  private unitLines(u: Unit, withVow = true): string[] {
    const s = effectiveStats(this.state, u);
    const moraleMove = u.moraleMove ? ` (${u.moraleMove} Shaken)` : '';
    const mods = u.modifiers.map((m) => abilityLabel(m.source)).join(', ');
    return [
      `CT ${u.ct}   Facing ${u.facing} ${this.screenArrow(u.facing)}`,
      `Atk ${s.atk}  Mag ${s.mag}  Def ${s.def}  Res ${s.res}`,
      `Spd ${s.spd}  Mv ${s.move}${moraleMove}  Jmp ${s.jump}  Eva ${s.eva}`,
      mods ? `Effects: ${mods}` : '',
      withVow ? this.vowLine(u) : '',
    ].filter(Boolean);
  }

  /** Screen-space arrow for a world facing at the current rotation. */
  private screenArrow(f: Facing): string {
    const d = screenDir(this.iso, DIRS[f]);
    return d.x > 0 ? (d.y > 0 ? '↘' : '↗') : d.y > 0 ? '↙' : '↖';
  }

  private vowLine(u: Unit): string {
    const v = this.state.vows[u.id];
    if (!v) return '';
    const held = v.status === 'intact' && v.progress >= v.goal;
    const key = v.frozen && v.status === 'intact' ? 'frozen' : v.status === 'fulfilled' ? 'kept' : v.status === 'broken' ? 'broken' : v.status === 'lapsed' ? 'lapsed' : held ? 'held' : 'intact';
    const progress = t(`ui.vows.${v.vowId}.progress`, vowParams(v.vowId, v.progress));
    return `${vowName(v.vowId)} · ${t(`ui.sigil.${key}.label`)} · ${t(`ui.sigil.${key}.tooltip`, { progress, goal: v.goal })}`;
  }

  /** Unit panel (UX §8): name in Pixelify 16, class, HP with a 60 x 5 bar, then CT, stats and the vow. */
  private refreshUnitPanel(): void {
    const a = activeUnit(this.state);
    this.unitHpBar.clear();
    if (!a) { for (const o of [this.unitTitle, this.unitClass, this.unitHp, this.unitBody]) o.setText(''); return; }
    this.unitTitle.setText(a.name).setColor(a.team === 'player' ? BONE : '#e0876a');
    this.unitClass.setText(a.team === 'player' ? this.className(a) : `Enemy · ${this.className(a)}`);
    this.unitHp.setText(`HP ${a.hp}/${a.base.hp}`);
    const bx = this.unitHp.x + this.unitHp.width + X(4);
    const by = Math.round((this.unitHp.y + this.unitHp.height / 2) / LP - 2.5) * LP;
    const frac = Math.max(0, a.hp / a.base.hp);
    this.unitHpBar.fillStyle(MARK.edge, 1).fillRect(bx - X(1), by - X(1), X(62), X(7));
    this.unitHpBar.fillStyle(0x3a3631, 1).fillRect(bx, by, X(60), X(5));
    this.unitHpBar.fillStyle(a.team === 'player' ? FACTION.squadHp : FACTION.court, 1).fillRect(bx, by, X(Math.round(60 * frac)), X(5));
    this.unitBody.setText(this.unitLines(a, false));
    this.drawVowRow(a);
  }

  /** Unit panel vow row (UX #47 review): a 13 lp sigil and "Lone Blade 0/1", or "No vow sworn" in grey. */
  private drawVowRow(u: Unit): void {
    const g = this.unitVow;
    g.clear();
    const y = Math.round((this.unitBody.y + this.unitBody.height) / LP + 8) * LP;
    this.unitVowText.setY(y);
    const v = this.state.vows[u.id];
    if (!v) { this.unitVowText.setX(X(12)).setText('No vow sworn').setColor('#8c8981'); return; }
    const held = v.status === 'intact' && v.progress >= v.goal;
    const frozen = v.frozen && v.status === 'intact';
    const color = v.status === 'broken' ? COLORS.violet : v.status === 'lapsed' ? COLORS.downed : held ? 0xf3e3b5 : COLORS.gold;
    const cx = X(12 + 6.5);
    const d = (r: number) => [{ x: cx, y: y - r }, { x: cx + r, y }, { x: cx, y: y + r }, { x: cx - r, y }];
    g.fillStyle(MARK.edge, 1).fillPoints(d(X(6.5)), true);
    g.fillStyle(color, frozen ? 0.4 : 1).fillPoints(d(X(5.5)), true);
    const state = v.status === 'intact' && !held && !frozen ? '' : ` · ${t(`ui.sigil.${frozen ? 'frozen' : v.status === 'fulfilled' ? 'kept' : v.status === 'intact' ? 'held' : v.status}.label`)}`;
    this.unitVowText.setX(X(29)).setColor(COLORS.text).setText(`${vowName(v.vowId)} ${v.progress}/${v.goal}${state}`);
  }

  private refreshPanels(preview: ActionPreview | null): void {
    this.refreshUnitPanel();
    this.refreshTargetControls();
    const a = activeUnit(this.state);
    let v: PanelView;
    if (preview) v = this.previewView(preview);
    else if (this.movePv) {
      const [head = '', ...lines] = this.movePreviewText(this.movePv).split('\n');
      v = { head, lines };
    } else {
      const hu = this.hover ? occupant(this.state, this.hover) : this.hoverUnitId ? getUnit(this.state, this.hoverUnitId) : undefined;
      v = hu && hu.id !== a?.id ? { head: `${hu.name} · ${this.className(hu)}`, lines: [`HP ${hu.hp}/${hu.base.hp}`, ...this.unitLines(hu)] } : this.tileView();
    }
    this.showPanel(v);
  }

  /** Target panel rows (UX §8): header, name row, hit and damage in Pixelify, HP after, then detail lines. */
  private showPanel(v: PanelView): void {
    const p = this.pv;
    const { h: H } = screenLp();
    const confirmOn = this.mode.kind === 'target' && !!this.mode.selected;
    p.head.setText(v.head);
    p.empty.setVisible(!v.head && !v.lines.length);
    // Keep the header clear of the ◀ ▶ arrows.
    while (p.head.width > X(124) && p.head.text.length > 3) p.head.setText(`${p.head.text.slice(0, -2)}…`);
    let y = X(H - 74);
    p.name.setText(v.name ?? '').setY(y);
    if (v.name) y += X(9);
    p.big.setText(v.big ?? '').setY(y - X(2));
    if (v.big) y += X(15);
    p.detail.setText(v.detail ?? '').setY(y);
    // The HP-after value turns red-orange when the hit downs the target or leaves it under a third.
    p.value.setText(v.value?.s ?? '').setColor(v.value?.warn ? '#c0533f' : COLORS.text).setPosition(p.detail.x + p.detail.width, y);
    if (v.detail) y += X(9);
    const stripY = confirmOn ? H - 39 : H - 21;
    p.strip.setVisible(!!v.strip).setY(X(stripY));
    p.stripText.setText(v.strip ?? '').setVisible(!!v.strip).setY(X(stripY + 5.5));
    const bottom = X(v.strip ? stripY - 1 : confirmOn ? H - 27 : H - 10);
    p.body.setY(y).setMaxLines(0).setText(v.lines.join('\n'));
    const n = p.body.getWrappedText().length;
    const lh = n ? p.body.height / n : X(9);
    p.body.setMaxLines(Math.max(0, Math.floor((bottom - y) / lh)) || 1).setText(v.lines.join('\n')).setVisible(bottom - y >= lh);
  }

  /** Show Confirm only once a target is selected, and the arrows while there is more than one target. */
  private refreshTargetControls(): void {
    const u = activeUnit(this.state);
    const m = this.mode;
    const sel = m.kind === 'target' ? m.selected : undefined;
    const valid = m.kind === 'target' && u ? targetTiles(this.state, u, m.abilityId) : [];
    if (sel && m.kind === 'target') {
      const who = occupant(this.state, sel);
      const label = `Confirm · ${abilityShort(m.abilityId)} → ${who ? shortName(who) : `tile ${sel.x},${sel.y}`}`;
      this.confirm.label.setText(label);
      if (this.confirm.label.width > X(152)) this.confirm.label.setText(label.replace('Confirm · ', ''));
    }
    for (const o of [this.confirm.bg, this.confirm.label]) o.setVisible(!!sel);
    for (const a of this.targetArrows) {
      const on = valid.length > 0;
      const many = valid.length > 1;
      (a as Phaser.GameObjects.Image).setVisible(on).setAlpha(many ? 1 : 0.35);
      (a.getData('glyph') as Phaser.GameObjects.Text | undefined)?.setVisible(on).setAlpha(many ? 1 : 0.35);
    }
  }

  /** "2 / 4" for the preview header while targeting. */
  private targetCount(): string {
    const u = activeUnit(this.state);
    if (this.mode.kind !== 'target' || !u) return '';
    const order = this.targetOrder(u, targetTiles(this.state, u, this.mode.abilityId));
    const cur = this.mode.selected ?? this.hover;
    const i = cur ? order.findIndex((p) => samePoint(p, cur)) : -1;
    return i >= 0 ? `  ${i + 1} / ${order.length}` : '';
  }

  private tileView(): PanelView {
    if (!this.hover) return { head: '', lines: [] };
    const tile = tileAt(this.state.map, this.hover);
    if (!tile) return { head: '', lines: [] };
    const kind = tile.kind === 'ground' ? 'Ground' : tile.kind === 'ford' ? 'Ford (costs 2)' : tile.kind === 'water' ? 'Water (impassable)' : 'Boulder (impassable)';
    return { head: `Tile ${this.hover.x},${this.hover.y}`, lines: [kind, `Height ${tile.height}`] };
  }

  private previewView(p: ActionPreview): PanelView {
    const actor = getUnit(this.state, p.actorId);
    const v: PanelView = { head: `${abilityLabel(p.abilityId)}${this.targetCount()}`, lines: [] };
    if (p.breaksVow) {
      const vow = this.state.vows[actor.id];
      const ally = this.state.units.find((o) => o.id !== actor.id && o.team === actor.team && o.status === 'ok' && Math.abs(o.pos.x - p.from.x) + Math.abs(o.pos.y - p.from.y) === 1);
      v.strip = `⚠ ${t('ui.preview.breaksVow')}${vow ? `: ${vowName(vow.vowId)}` : ''}`;
      if (vow && ally) v.lines.push(t('ui.preview.breaksVowDetail', { vow: vowName(vow.vowId), ally: ally.name }));
    }
    if (p.interceptedBy) v.lines.unshift(`Guarded: ${getUnit(this.state, p.interceptedBy).name} takes the hit`);
    // An area hit lists one line per unit, allies first, so the ally line is never pushed under Confirm (QA #43).
    if (p.victims.length > 1) {
      const name = (u: Unit) => (shortName(u) !== u.name ? shortName(u) : u.name);
      const mine = (id: string) => Number(getUnit(this.state, id).team === actor.team);
      const vs = [...p.victims].sort((a, b) => mine(b.unitId) - mine(a.unitId));
      v.name = `Hits: ${vs.map((x) => { const u = getUnit(this.state, x.unitId); return `${name(u)}${u.team === actor.team && x.damage ? ' (ally)' : ''}`; }).join(', ')}`;
      for (const x of vs) {
        const u = getUnit(this.state, x.unitId);
        const ally = u.team === actor.team && x.damage ? '⚠ ' : '';
        if (x.heal || x.revives) v.lines.push(`${name(u)}: ${x.revives ? 'revive, ' : ''}heal ${x.heal}  HP ${u.hp} → ${x.hpAfter}`);
        else if (x.damage) v.lines.push(`${ally}${name(u)}: ${x.hit}%  ${x.damage} dmg  HP ${u.hp} → ${x.hpAfter}${x.downs ? ' ☠' : ''}`);
        else v.lines.push(`${name(u)}: ${describeEffect(p.abilityId)}`);
      }
      if (this.mode.kind === 'target' && !this.mode.selected) v.lines.push('Click to select');
      return v;
    }
    p.victims.forEach((x, i) => {
      const u = getUnit(this.state, x.unitId);
      const who = `${shortName(u) !== u.name ? `${shortName(u)} · ` : ''}${u.name}${x.damage && u.team === actor.team ? ' (ally!)' : ''}`;
      const tags = [t(`ui.preview.${x.side}`), x.heightDiff > 0 ? `${t('ui.preview.highGround')} +${x.heightDiff}` : x.heightDiff < 0 ? `${t('ui.preview.lowGround')} ${x.heightDiff}` : ''].filter(Boolean).join(' · ');
      if (i === 0 && (x.damage || x.heal || x.revives)) {
        v.name = who;
        if (x.heal || x.revives) {
          v.big = `${x.revives ? 'Revive  ' : ''}Heal ${x.heal}`;
          v.detail = `${t('ui.preview.hpAfter')} ${u.hp} → `;
          v.value = { s: `${x.hpAfter}`, warn: false };
        } else {
          v.big = `${t('ui.preview.hit')} ${x.hit}%  ${t('ui.preview.damage')} ${x.damage}`;
          v.detail = `${t('ui.preview.hpAfter')} ${u.hp} → `;
          v.value = { s: `${x.hpAfter}${x.downs ? ' ☠' : ''}`, warn: x.downs || x.hpAfter < u.base.hp / 3 };
          v.lines.unshift(`${tags}${x.pushedTo ? ' · pushed' : ''}`);
        }
      } else if (x.heal || x.revives) v.lines.push(`${u.name}: ${x.revives ? 'revive, ' : ''}heal ${x.heal}  HP ${u.hp} → ${x.hpAfter}`);
      else if (x.damage) v.lines.push(`${who}: ${x.hit}% ${x.damage}  HP ${u.hp} → ${x.hpAfter}${x.downs ? ' ☠' : ''}`);
      else v.lines.push(`${u.name}: ${describeEffect(p.abilityId)}`);
    });
    if (this.mode.kind === 'target' && !this.mode.selected) v.lines.push('Click to select');
    return v;
  }

  private refreshUnits(): void {
    this.placedSigils = []; // sigils placed this pass count as obstacles for the next (QA #33 follow-up)
    for (const u of this.state.units) this.drawUnit(u);
    this.liftHpBars();
  }

  /** Neighbouring HP bars that would overlap on screen: the unit further back lifts its bar 5 lp per clash. */
  private liftHpBars(): void {
    const live = this.state.units.filter((u) => u.status === 'ok' && this.views.get(u.id)?.sprite)
      .sort((a, b) => depthOf(this.iso, b.pos.x, b.pos.y) - depthOf(this.iso, a.pos.x, a.pos.y));
    const placed: Vec[] = [];
    for (const u of live) {
      const v = this.views.get(u.id)!;
      let lift = 0;
      while (lift > -30 && placed.some((p) => Math.abs(p.x - v.root.x) < 46 && Math.abs(p.y - (v.root.y + lift)) < 11)) lift -= 10;
      // Two lifts at most (UX): past that the back bar only shows on hover, or for the active unit or target.
      const clash = lift <= -30 && placed.some((p) => Math.abs(p.x - v.root.x) < 46 && Math.abs(p.y - (v.root.y + lift)) < 11);
      const sel = this.mode.kind === 'target' ? this.mode.selected : undefined;
      const keep = this.hoverUnitId === u.id || samePoint(this.hover ?? { x: -1, y: -1 }, u.pos) || this.state.activeId === u.id || (!!sel && samePoint(sel, u.pos));
      v.hp.setY(clash ? -20 : lift).setVisible(!clash || keep);
      if (clash && !keep) continue;
      placed.push({ x: v.root.x, y: v.root.y + lift });
    }
  }

  /** Redraw tile highlights for the current mode and hover. */
  private refreshOverlays(): ActionPreview | null {
    for (const g of this.overlays) g.clear();
    this.targetMark.clear().setData('draw', null).setData('frame', -1);
    this.movePv = null;
    const u = activeUnit(this.state);
    let preview: ActionPreview | null = null;
    const paint = (p: Point, color: number, alpha: number, stroke = false, width = 2) => {
      const g = this.overlays[p.y * this.state.map.width + p.x];
      if (!g) return;
      const d = topDiamond(this.iso, p.x, p.y, heightAt(this.state.map, p));
      if (stroke) g.lineStyle(width, color, alpha).strokePoints(d, true);
      else g.fillStyle(color, alpha).fillPoints(d, true);
    };
    /** UX §4: 2 lp of colour with a 1 lp dark edge (1 lp = 2 layout units at map zoom 1). */
    const mark = (p: Point, color: number, brackets = false, into?: Phaser.GameObjects.Graphics) => {
      const g = into ?? this.overlays[p.y * this.state.map.width + p.x];
      if (!g) return;
      const d = topDiamond(this.iso, p.x, p.y, heightAt(this.state.map, p));
      // Same family as the GUI frames (Art): the cursor sheet's navy drop edge, 1 lp lower, under a 2 lp line.
      const drop = d.map((q) => ({ x: q.x, y: q.y + 2 }));
      g.lineStyle(8, CURSOR.edge, 1).strokePoints(drop, true);
      g.lineStyle(4, color, 1).strokePoints(d, true);
      if (!brackets) return;
      // Four corner brackets just outside the diamond, 3 lp along each edge.
      const c = { x: d.reduce((a, q) => a + q.x, 0) / 4, y: d.reduce((a, q) => a + q.y, 0) / 4 };
      for (let i = 0; i < 4; i++) {
        const v = d[i]!, out = { x: v.x + (v.x - c.x) * 0.25, y: v.y + (v.y - c.y) * 0.25 };
        for (const n of [d[(i + 1) % 4]!, d[(i + 3) % 4]!]) {
          const len = Math.hypot(n.x - v.x, n.y - v.y);
          const e = { x: out.x + ((n.x - v.x) / len) * 12, y: out.y + ((n.y - v.y) / len) * 12 };
          g.lineStyle(8, CURSOR.edge, 1).lineBetween(out.x, out.y + 2, e.x, e.y + 2);
          g.lineStyle(4, color, 1).lineBetween(out.x, out.y, e.x, e.y);
        }
      }
    };
    // Bulwark break radius (UX): faint gold outline on tiles within breakRadius while the vow is Intact or Held.
    for (const b of this.state.units) {
      const v = this.state.vows[b.id];
      if (!v || v.vowId !== 'bulwark' || v.status !== 'intact' || v.frozen || b.status !== 'ok') continue; // hidden when Kept, Broken or frozen
      const r = VOWS.bulwark.breakRadius;
      for (let y = b.pos.y - r; y <= b.pos.y + r; y++) {
        for (let x = b.pos.x - r; x <= b.pos.x + r; x++) {
          if (Math.abs(x - b.pos.x) + Math.abs(y - b.pos.y) <= r && tileAt(this.state.map, { x, y })) paint({ x, y }, 0xc9a35a, 0.55, true, 1.5);
        }
      }
    }
    if (u && u.team === 'player') {
      if (this.mode.kind === 'move' && !this.state.moved) {
        const tree = pathTree(this.state, u);
        for (const n of reachableTiles(this.state, u)) paint(n.pos, COLORS.move, 0.55); // UX: 55% so the pale blue survives the bright pack grass
        if (this.hover && tree.has(key(this.hover)) && !occupant(this.state, this.hover)) {
          for (const p of pathTo(tree, this.hover)) paint(p, COLORS.move, 0.55);
        }
        // Move preview (#21): from a reachable tile, or the unit's own tile ("stay and attack").
        const h = this.hover;
        if (h && (samePoint(h, u.pos) || (tree.has(key(h)) && !occupant(this.state, h)))) this.movePv = this.movePreviewAt(u, h);
      } else if (this.mode.kind === 'move' && !this.state.acted) {
        // After moving, keep showing who is in reach from where the unit now stands (QA #26).
        this.movePv = this.movePreviewAt(u, u.pos);
      }
      if (this.movePv && this.mode.kind === 'move') {
        const from = this.state.moved ? u.pos : this.hover!;
        paint(from, PV.bone, this.state.moved ? 0.35 : 0.75);
        for (const t of this.movePv.threats) {
          const e = getUnit(this.state, t.unitId);
          const g = this.overlays[e.pos.y * this.state.map.width + e.pos.x];
          const c = tileCenter(this.iso, e.pos.x, e.pos.y, heightAt(this.state.map, e.pos));
          g?.lineStyle(3, PV.ring, 1).strokeEllipse(c.x, c.y, 44, 20);
          if (t.canDown) g?.lineStyle(1.5, PV.ring, 1).strokeEllipse(c.x, c.y, 54, 26); // could be downed from here
        }
      }
      if (this.mode.kind === 'target') {
        const a = ABILITIES[this.mode.abilityId]!;
        for (let y = 0; y < this.state.map.height; y++) {
          for (let x = 0; x < this.state.map.width; x++) {
            if (a.type !== 'self' && inRange(this.state, a, u.pos, { x, y })) paint({ x, y }, COLORS.range, 0.18); // attack range stays faint: red over the pack grass turns olive above ~20%
          }
        }
        const valid = targetTiles(this.state, u, this.mode.abilityId);
        for (const p of valid) paint(p, COLORS.target, 0.9, true);
        const aim = this.mode.selected ?? (this.hover && valid.some((p) => samePoint(p, this.hover!)) ? this.hover : null);
        if (aim) {
          const area = a.type === 'self' ? [u.pos] : areaTiles(this.state, a, u.pos, aim);
          // Single-tile abilities show only the target outline; the area fill is for real areas (UX §4).
          if (area.length > 1 || !this.mode.selected) for (const p of area) paint(p, MARK.area, 0.45);
          if (this.mode.selected) {
            // The confirmed target pulses through the cursor sheet's frame colours (Art, #47); see update().
            const sp = this.mode.selected;
            this.targetMark.setDepth(depthOf(this.iso, sp.x, sp.y) * 10 + 2).setData('draw', (c: number) => { this.targetMark.clear(); mark(sp, c, true, this.targetMark); });
          }
          preview = previewAction(this.state, u, this.mode.abilityId, aim);
        }
      } else if (this.mode.kind === 'facing') {
        for (const f of FACINGS) {
          const p = { x: u.pos.x + DIRS[f].x, y: u.pos.y + DIRS[f].y };
          if (tileAt(this.state.map, p)) paint(p, COLORS.gold, f === this.mode.facing ? 0.6 : 0.2);
        }
      }
    }
    // Active unit's tile: bone outline and a 30% bone fill; hover: bone outline only (UX §4).
    if (u && u.status === 'ok') { paint(u.pos, MARK.bone, 0.3); mark(u.pos, MARK.bone); }
    const sel = this.mode.kind === 'target' ? this.mode.selected : undefined;
    if (this.hover && tileAt(this.state.map, this.hover) && !(sel && samePoint(sel, this.hover))) mark(this.hover, MARK.bone);
    return preview;
  }

  private refresh(): void {
    const preview = this.refreshOverlays();
    this.refreshUnits();
    this.drawChips();
    this.refreshPanels(preview);
    this.refreshButtons();
    this.refreshTimeline();
    this.refreshMorale();
    this.refreshHint();
    this.flushEvents();
    if (this.debug) this.debugText.setText(this.debugDump(preview));
  }

  // ---------- move preview (#21) ----------

  private movePreviewAt(u: Unit, p: Point): MovePreview {
    const k = `${this.state.turnNumber}:${u.id}:${key(p)}`;
    let mp = this.movePvCache.get(k);
    if (!mp) {
      if (this.movePvCache.size > 200) this.movePvCache.clear();
      mp = movePreview(this.state, u, p);
      this.movePvCache.set(k, mp);
    }
    return mp;
  }

  /** Clears old move-preview chips. QA #25: chips covered enemy tokens, so the rings on the map
   *  plus the From-this-tile panel carry the detail now. */
  private drawChips(): void {
    for (const o of this.chips) o.destroy();
    this.chips = [];
  }

  private movePreviewText(mp: MovePreview): string {
    const n = mp.threats.length;
    const lines = [n ? t('ui.fromTile.targets', { n }) : t('ui.fromTile.none')];
    for (const t of mp.threats.slice(0, 4)) {
      const codes = t.abilities.map((a) => `${a.area ? `[${abilityCode(a.abilityId)}]` : abilityCode(a.abilityId)}${a.hitsAlly ? '⚠' : ''}`).join(' ');
      lines.push(`${shortName(getUnit(this.state, t.unitId)).padEnd(12)} ${codes.padEnd(14)} ${sideTag(t)}${t.canDown ? ' ☠' : ''}`);
    }
    if (n > 4) lines.push(`+${n - 4} more`);
    const used = [...new Set(mp.threats.flatMap((t) => t.abilities.map((a) => a.abilityId)))];
    if (used.length) lines.push('', used.map((id) => `${abilityCode(id)} ${abilityLabel(id)}`).join(' · '));
    if (mp.threats.some((t) => t.abilities.some((a) => a.hitsAlly))) lines.push('⚠ would also catch an ally');
    for (const x of mp.excluded) {
      lines.push(x.reason === 'cooldown' ? t('ui.fromTile.cooling', { ability: abilityLabel(x.abilityId), n: x.readyIn ?? 0 }) : t('ui.fromTile.used', { ability: abilityLabel(x.abilityId) }));
    }
    if (mp.breaksLoneBlade) lines.push(t('ui.fromTile.breaksLoneBlade'));
    return lines.join('\n');
  }

  private refreshHint(): void {
    const u = activeUnit(this.state);
    let h = '';
    if (this.mode.kind === 'deploy') h = ''; // the swear panel carries its own Begin button
    else if (!u) h = '';
    else if (u.team === 'enemy') h = `${u.name} is acting…`;
    else if (this.mode.kind === 'move') h = this.state.moved ? 'Choose an action, or End turn' : 'Click a blue tile to move, or choose an action';
    else if (this.mode.kind === 'target') h = this.mode.selected ? 'Click again or Enter to confirm. Tab for next target.' : 'Click a target to select it. Tab cycles targets. Right-click to cancel';
    else if (this.mode.kind === 'facing') h = 'Choose facing: click a gold tile or use arrow keys, Enter to confirm';
    this.setHint(h);
  }

  // ---------- input ----------

  private bindInput(): void {
    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.drag && p.isDown) {
        const cam = this.cameras.main;
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (this.drag.moved || Math.hypot(dx, dy) > 6) {
          this.drag.moved = true;
          cam.scrollX -= dx / cam.zoom;
          cam.scrollY -= dy / cam.zoom;
          this.clampCamera();
          this.drag.x = p.x;
          this.drag.y = p.y;
          return;
        }
      }
      const t = this.onBoard(p) ? this.pick(this.cameras.main.getWorldPoint(p.x, p.y)) : null;
      if (t?.x === this.hover?.x && t?.y === this.hover?.y) return;
      this.setHover(t);
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (over.length || !this.onBoard(p)) { if (p.rightButtonDown()) this.cancel(); return; }
      this.drag = { x: p.x, y: p.y, moved: false, button: p.button };
    });
    this.input.on('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved) return;
      // Right-click without dragging cancels; right/middle drag pans (UX §2).
      if (d.button === 2) { this.cancel(); return; }
      if (d.button !== 0) return;
      const p = this.input.activePointer;
      const t = this.pick(this.cameras.main.getWorldPoint(p.x, p.y));
      if (t) { this.hover = t; void this.clickTile(t); }
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      if (this.onBoard(p)) this.zoomStep(dy > 0 ? -1 : 1, p);
    });
    const kb = this.input.keyboard!;
    kb.on('keydown', (e: KeyboardEvent) => {
      if (this.overlayKind) {
        if (this.overlayKind === 'pause' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          const n = this.pauseRows.length;
          this.pauseRows[(this.pauseFocus + (e.key === 'ArrowUp' ? n - 1 : 1)) % n]!.focus();
          sfx(this, 'ui_hover');
        } else if (this.overlayKind === 'pause' && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          this.pauseRows[this.pauseFocus]?.press();
        } else if (e.key === 'Escape' || e.key === 'h' || e.key === 'H' || e.key === '?') this.closeOverlay();
        return;
      }
      if (e.key === 'h' || e.key === 'H' || e.key === '?') { this.openOverlay('help'); return; }
      if (e.key >= '1' && e.key <= '9') this.pressAction(Number(e.key) - 1);
      else if (e.key === 'w' || e.key === 'W') this.pressAction(this.buttons.findIndex((b) => b.id === 'wait'));
      else if (e.key === 'Escape') { if (!this.cancel() && ['move', 'facing', 'deploy'].includes(this.mode.kind)) this.openOverlay('pause'); }
      else if (e.key === 'm' || e.key === 'M') toggleMute(this);
      else if (e.key === 'd' || e.key === 'D') this.toggleDebug();
      else if (e.key === 'q' || e.key === 'Q') this.rotateView(-1);
      else if (e.key === 'e' || e.key === 'E') this.rotateView(1);
      else if (e.key === 'r' || e.key === 'R' || e.key === 'Home') this.resetCamera();
      else if (e.key === '+' || e.key === '=') this.zoomStep(1);
      else if (e.key === '-' || e.key === '_') this.zoomStep(-1);
      else if (e.key === 'c' || e.key === 'C') this.centerOnActive();
      else if (this.mode.kind !== 'facing' && e.key.startsWith('Arrow')) {
        const cam = this.cameras.main;
        const step = (48 * layoutScale()) / cam.zoom;
        if (e.key === 'ArrowLeft') cam.scrollX -= step;
        if (e.key === 'ArrowRight') cam.scrollX += step;
        if (e.key === 'ArrowUp') cam.scrollY -= step;
        if (e.key === 'ArrowDown') cam.scrollY += step;
        this.clampCamera();
      }
      else if (e.key === 'Tab') { e.preventDefault(); this.cycleTarget(e.shiftKey ? -1 : 1); }
      else if ((e.key === 'Enter' || e.key === ' ') && this.mode.kind === 'target') { e.preventDefault(); this.confirmTarget(); }
      else if (e.key === 'Enter' && this.mode.kind === 'move' && this.hover) void this.clickTile(this.hover);
      else if (this.mode.kind === 'facing') {
        // Arrow keys mean the same screen direction at every rotation.
        const screen: Record<string, Facing> = { ArrowUp: 'N', ArrowRight: 'E', ArrowDown: 'S', ArrowLeft: 'W' };
        const want = screen[e.key] ? DIRS[screen[e.key]!] : null;
        const f = want ? FACINGS.find((g) => samePoint(viewDir(this.iso, DIRS[g]), want)) : undefined;
        const u = activeUnit(this.state);
        if (f && u) { this.mode = { kind: 'facing', facing: f }; u.facing = f; this.refresh(); }
        if (e.key === 'Enter') this.confirmFacing();
      }
    });
  }

  // ---------- camera (#19) ----------

  /**
   * The main camera shows the board and can pan, zoom and rotate; a second, fixed camera
   * draws the HUD. Objects at depth 999 and above are HUD; everything else is board.
   */
  private setupCameras(): void {
    this.homeCamera();
    this.uiCam = this.cameras.add(0, 0, 1280, 720).setName('ui');
    fitCamera(this.uiCam);
    this.events.on(Phaser.Scenes.Events.PRE_RENDER, this.sortCameras, this);
    this.events.on(RESCALE, this.onRescale, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.events.off(Phaser.Scenes.Events.PRE_RENDER, this.sortCameras, this);
      this.events.off(RESCALE, this.onRescale, this);
    });
  }

  /** Map zoom as a multiple of the layout zoom: 1 is the default view at any window size. */
  private get mapZoom(): number { return this.cameras.main.zoom / layoutScale(); }

  /** The whole-number scale changed (window resized): keep the board centre and the nearest zoom step. */
  private onRescale(): void {
    const main = this.cameras.main;
    // The canvas has already been resized, so use the size the camera had when it last rendered.
    const centre = { x: main.scrollX + this.lastCamSize.w / 2, y: main.scrollY + this.lastCamSize.h / 2 };
    const was = main.zoom / this.lastLayoutScale;
    this.lastLayoutScale = layoutScale();
    const zs = mapZooms();
    const z = zs.reduce((best, v) => (Math.abs(v - was) < Math.abs(best - was) ? v : best), zs[0]!);
    fitCamera(main);
    main.setZoom(layoutScale() * z).centerOn(centre.x, centre.y);
    fitCamera(this.uiCam);
    this.lastCamSize = { w: main.width, h: main.height };
    this.clampCamera();
    // The logical screen changed size: lay the HUD out again on the new W x H (UX §8).
    this.closeOverlay();
    this.buildHud();
    this.redrawDeploy?.();
    this.refresh();
  }

  /** Map safe area centre in layout units (UX §8: y 50 to H - 117 lp); centring and pans aim here. */
  private safeCentre(): Vec {
    const { w: W, h: H } = screenLp();
    return { x: X(W / 2), y: X((50 + H - 117) / 2) };
  }

  /** Camera scroll that puts world point w at the safe-area centre. */
  private scrollToSafe(w: Vec): Vec {
    const c = this.cameras.main;
    const s = this.safeCentre();
    const ls = layoutScale();
    return { x: w.x - c.width / 2 - (s.x * ls - c.width / 2) / c.zoom, y: w.y - c.height / 2 - (s.y * ls - c.height / 2) / c.zoom };
  }

  /** Default framing: layout zoom, the map centre in the middle of the safe area. */
  private homeCamera(): void {
    const c = this.cameras.main;
    fitCamera(c);
    this.lastCamSize = { w: c.width, h: c.height };
    const { width, height } = this.state.map;
    const m = this.scrollToSafe(tileCenter(this.iso, (width - 1) / 2, (height - 1) / 2, 0));
    c.setScroll(m.x, m.y);
  }

  private lastLayoutScale = layoutScale();
  private lastCamSize = { w: canvasSize().width, h: canvasSize().height };

  private sortCameras(): void {
    for (const o of this.children.list) {
      if (this.sorted.has(o)) continue;
      this.sorted.add(o);
      const depth = (o as unknown as { depth: number }).depth;
      if (depth >= 999) this.cameras.main.ignore(o);
      else this.uiCam.ignore(o);
    }
  }

  /** True when the pointer is over the board area, not the timeline strip or the bottom panels. */
  private onBoard(p: Phaser.Input.Pointer): boolean {
    const s = layoutScale() * LP; // pointer is in canvas pixels; the HUD is laid out in lp
    const x = p.x / s, y = p.y / s;
    const c = this.camRect;
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return false;
    return y > 46 && y < screenLp().h - 96;
  }

  /** Zoom steps keep every art pixel a whole number of device pixels (src/view.ts, UX camera spec). */
  private zoomStep(dir: number, at?: Phaser.Input.Pointer): void {
    const zs = mapZooms();
    const cur = this.mapZoom;
    let i = zs.findIndex((z) => Math.abs(z - cur) < 0.01);
    if (i < 0) i = zs.findIndex((z) => z >= 1);
    const next = zs[Math.max(0, Math.min(zs.length - 1, i + dir))]!;
    if (Math.abs(next - cur) > 0.001) this.zoomBy(next / cur, at);
  }

  /** Visible world rectangle of the main camera, worked out from scroll and zoom. */
  private worldView(): { l: number; r: number; t: number; b: number } {
    const c = this.cameras.main;
    const hw = c.width / 2 / c.zoom;
    const hh = c.height / 2 / c.zoom;
    return { l: c.scrollX + c.width / 2 - hw, r: c.scrollX + c.width / 2 + hw, t: c.scrollY + c.height / 2 - hh, b: c.scrollY + c.height / 2 + hh };
  }

  /** Keep at least part of the map on screen. */
  private clampCamera(): void {
    const { width, height } = this.state.map;
    const pts = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].map(([x, y]) => tileCenter(this.iso, x!, y!, 0));
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const c = this.cameras.main;
    const v = this.worldView();
    const m = 64;
    if (v.r < minX + m) c.scrollX += minX + m - v.r;
    if (v.l > maxX - m) c.scrollX -= v.l - (maxX - m);
    if (v.b < minY + m) c.scrollY += minY + m - v.b;
    if (v.t > maxY - m) c.scrollY -= v.t - (maxY - m);
  }

  /** Screen point of a world point (camera matrix only updates at render, so by hand). */
  private toScreen(w: Vec): Vec {
    const c = this.cameras.main;
    return { x: (w.x - c.scrollX - c.width / 2) * c.zoom + c.width / 2, y: (w.y - c.scrollY - c.height / 2) * c.zoom + c.height / 2 };
  }

  private centerOnActive(animate = false): void {
    const u = activeUnit(this.state);
    if (!u) return;
    const w = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
    const c = this.cameras.main;
    // Centre on the map safe area (UX §8), not the whole canvas.
    const { x: sx, y: sy } = this.scrollToSafe({ x: w.x, y: w.y - 20 });
    if (animate) this.tweens.add({ targets: c, scrollX: sx, scrollY: sy, duration: 300, ease: 'Sine.easeInOut' });
    else c.setScroll(sx, sy);
  }

  /** Auto-follow (UX §2): pan to the acting unit if it is off-screen or near a HUD panel. */
  private followActive(): void {
    const u = activeUnit(this.state);
    if (!u) return;
    const raw = this.toScreen(tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos)));
    const s = { x: raw.x / layoutScale(), y: raw.y / layoutScale() };
    const { w: W, h: H } = screenLp();
    if (s.x < 120 || s.x > X(W) - 120 || s.y < X(50) + 100 || s.y > X(H - 117) - 40) this.centerOnActive(true);
  }

  private zoomBy(f: number, at?: Phaser.Input.Pointer): void {
    // Keep the world point under the pointer fixed. Worked out by hand because the
    // camera matrix only updates at render time.
    const cam = this.cameras.main;
    const sx = at?.x ?? cam.width / 2;
    const sy = at?.y ?? cam.height / 2;
    const wx = (sx - cam.width / 2) / cam.zoom + cam.width / 2 + cam.scrollX;
    const wy = (sy - cam.height / 2) / cam.zoom + cam.height / 2 + cam.scrollY;
    const zs = mapZooms();
    const z = Phaser.Math.Clamp(cam.zoom * f, zs[0]! * layoutScale(), zs[zs.length - 1]! * layoutScale());
    cam.setZoom(z);
    cam.scrollX = wx - (sx - cam.width / 2) / z - cam.width / 2;
    cam.scrollY = wy - (sy - cam.height / 2) / z - cam.height / 2;
    this.clampCamera();
  }

  private resetCamera(): void {
    this.homeCamera();
    if ((this.iso.rot ?? 0) !== 0) this.rotateView(-(this.iso.rot ?? 0));
  }

  /** Turn the board a quarter turn (dir 1 = clockwise), keeping the map centre where it was on screen. */
  private rotateView(dir: number): void {
    if (this.mode.kind === 'busy' && this.tweens.getTweens().length) return;
    const { width, height } = this.state.map;
    const mid = (w: number, h: number) => tileCenter(this.iso, (w - 1) / 2, (h - 1) / 2, 0);
    const before = mid(width, height);
    this.iso = { ...this.iso, rot: ((((this.iso.rot ?? 0) + dir) % 4) + 4) % 4 };
    const after = mid(width, height);
    this.cameras.main.scrollX += after.x - before.x;
    this.cameras.main.scrollY += after.y - before.y;
    this.drawMap();
    for (const u of this.state.units) this.placeUnit(u, u.pos);
    // Speech bubbles follow their speaker to the new view position.
    for (const [id, b] of this.bubbles) {
      const u = this.state.units.find((x) => x.id === id);
      if (!u) continue;
      const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
      b.setPosition(c.x + 14, c.y - 52);
    }
    this.drawCompass();
    // Re-run hover hit-testing: a different tile is under the cursor now.
    const p = this.input.activePointer;
    this.hover = this.onBoard(p) ? this.pick(this.cameras.main.getWorldPoint(p.x, p.y)) : this.hover;
    this.refresh();
  }

  private drawCompass(): void {
    const g = this.compass;
    if (!g?.active) return;
    const { x: cx, y: cy } = this.compassAt;
    const d = screenDir(this.iso, DIRS.N);
    const len = Math.hypot(d.x, d.y);
    const nx = d.x / len, ny = d.y / len;
    const r = X(9);
    g.clear();
    g.fillStyle(MARK.edge).fillCircle(cx, cy, r + X(1)).fillStyle(0x3a3631).fillCircle(cx, cy, r);
    g.fillStyle(0xc0533f).fillTriangle(cx + nx * X(7), cy + ny * X(7), cx - ny * X(2.5), cy + nx * X(2.5), cx + ny * X(2.5), cy - nx * X(2.5));
    g.fillStyle(0xb9b2a2).fillTriangle(cx - nx * X(6), cy - ny * X(6), cx - ny * X(2.5), cy + nx * X(2.5), cx + ny * X(2.5), cy - nx * X(2.5));
    this.compassLabel?.setPosition(cx + nx * X(13), cy + ny * X(12));
  }
  private compassLabel?: Phaser.GameObjects.Text;

  /** Dragon Regalia frame behind a HUD rectangle; the rectangle stays as the plain fallback (canvas renderer). */
  private skinPanel(r: Phaser.GameObjects.Rectangle): Phaser.GameObjects.NineSlice | null {
    const p = guiPanel(this, r.x, r.y, r.width, r.height);
    if (!p) return null;
    p.setDepth(r.depth);
    r.setVisible(false);
    return p;
  }

  /** Dragon Regalia button under an interactive rectangle, which keeps the input but stops drawing. Hover lights it. */
  private skinButton(r: Phaser.GameObjects.Rectangle, state: ButtonState): Phaser.GameObjects.NineSlice | null {
    const b = guiButton(this, r.x, r.y, r.width, r.height);
    if (!b) return null;
    b.setDepth(r.depth);
    r.setFillStyle(0x000000, 0).setStrokeStyle();
    this.setSkin(b, state);
    r.on('pointerover', () => {
      const base = b.getData('base') as ButtonState;
      if (base === 'rest') setButtonState(b, 'hover');
      else if (base === 'primary') setButtonState(b, 'primary-hover');
    });
    r.on('pointerout', () => setButtonState(b, b.getData('base') as ButtonState));
    r.once('destroy', () => b.destroy());
    return b;
  }

  private setSkin(b: Phaser.GameObjects.NineSlice, state: ButtonState): void {
    const hovered = b.getData('state') === 'hover' || b.getData('state') === 'primary-hover';
    b.setData('base', state);
    setButtonState(b, hovered && state === 'rest' ? 'hover' : hovered && state === 'primary' ? 'primary-hover' : state);
  }

  /** Units first (their bodies stand above the terrain), then tiles front to back. */
  private pick(p: Vec): Point | null {
    const units = this.state.units.filter((u) => u.status !== 'lost').sort((a, b) => depthOf(this.iso, b.pos.x, b.pos.y) - depthOf(this.iso, a.pos.x, a.pos.y));
    for (const u of units) {
      const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
      const top = u.status === 'downed' ? c.y - 14 : c.y - this.tokenH - 3;
      if (Math.abs(p.x - c.x) <= 16 && p.y >= top && p.y <= c.y + 2) return { ...u.pos };
    }
    return pickTile(this.iso, this.state.map.width, this.state.map.height, (x, y) => heightAt(this.state.map, { x, y }), p);
  }

  private setHover(t: Point | null): void {
    this.hover = t;
    const occ = t ? occupant(this.state, t) : undefined;
    this.hoverUnitId = occ?.id ?? null;
    if (this.mode.kind === 'facing' && t) {
      const u = activeUnit(this.state);
      if (u && !samePoint(u.pos, t)) this.mode = { kind: 'facing', facing: facingToward(u.pos, t, this.mode.facing) };
      if (u) u.facing = this.mode.facing;
    }
    this.refresh();
  }

  /**
   * Tab / Shift+Tab: step through valid targets (or move tiles), so tiles hidden behind
   * high ground can always be chosen. Enter confirms.
   */
  private cycleTarget(dir: number): void {
    const u = activeUnit(this.state);
    if (!u || u.team !== 'player') return;
    let valid: Point[] = [];
    if (this.mode.kind === 'target') valid = targetTiles(this.state, u, this.mode.abilityId);
    else if (this.mode.kind === 'move' && !this.state.moved) valid = reachableTiles(this.state, u).map((n) => n.pos).filter((p) => !samePoint(p, u.pos));
    if (!valid.length) return;
    if (this.mode.kind === 'target') {
      const order = this.targetOrder(u, valid);
      const cur = this.mode.selected ?? this.hover;
      const i = cur ? order.findIndex((p) => samePoint(p, cur)) : -1;
      this.selectTarget(order[(i + dir + order.length) % order.length]!, true);
      return;
    }
    const i = this.hover ? valid.findIndex((p) => samePoint(p, this.hover!)) : -1;
    this.setHover(valid[(i + dir + valid.length) % valid.length]!);
  }

  /** Tab order (UX §3): nearest first, then clockwise from screen north. */
  private targetOrder(u: Unit, valid: Point[]): Point[] {
    const from = tileCenter(this.iso, u.pos.x, u.pos.y, 0);
    const angle = (p: Point) => {
      const c = tileCenter(this.iso, p.x, p.y, 0);
      return (Math.atan2(c.x - from.x, -(c.y - from.y)) + Math.PI * 2) % (Math.PI * 2);
    };
    const dist = (p: Point) => Math.abs(p.x - u.pos.x) + Math.abs(p.y - u.pos.y);
    return [...valid].sort((a, b) => dist(a) - dist(b) || angle(a) - angle(b));
  }

  /** First step of targeting: select, show the preview, keep the target on screen. */
  private selectTarget(p: Point, pan = false): void {
    if (this.mode.kind !== 'target') return;
    this.mode = { ...this.mode, selected: { ...p } };
    sfx(this, 'ui_hover');
    this.hover = { ...p };
    this.hoverUnitId = occupant(this.state, p)?.id ?? null;
    if (pan) this.panTo(p);
    this.refresh();
  }

  /** Second step: Enter, Space, the Confirm button or a click on the selection. */
  private confirmTarget(): void {
    if (this.mode.kind !== 'target') return;
    if (this.mode.selected) { void this.clickTile(this.mode.selected); return; }
    const u = activeUnit(this.state);
    if (u && this.hover && targetTiles(this.state, u, this.mode.abilityId).some((t) => samePoint(t, this.hover!))) this.selectTarget(this.hover);
  }

  /** Ease the camera to a tile only if it is off the board area (UX §3, 150 ms). */
  private panTo(p: Point): void {
    const ls = layoutScale();
    const raw = this.toScreen(tileCenter(this.iso, p.x, p.y, heightAt(this.state.map, p)));
    const sx = raw.x / ls, sy = raw.y / ls;
    const { w: W, h: H } = screenLp();
    if (sx > 80 && sx < X(W) - 80 && sy > X(50) + 60 && sy < X(H - 117) - 20) return;
    const c = this.cameras.main;
    const to = this.scrollToSafe(tileCenter(this.iso, p.x, p.y, heightAt(this.state.map, p)));
    this.tweens.add({ targets: c, scrollX: to.x, scrollY: to.y, duration: 150, ease: 'Sine.easeOut' });
  }

  private pressAction(i: number): void {
    const b = this.buttons[i];
    const u = activeUnit(this.state);
    if (!b || !u || u.team !== 'player' || (this.mode.kind !== 'move' && this.mode.kind !== 'target')) return;
    sfx(this, 'ui_click');
    if (b.id === 'wait') {
      this.mode = { kind: 'facing', facing: u.facing };
    } else {
      if (this.state.acted || !abilityReady(u, b.id) || !targetTiles(this.state, u, b.id).length) return;
      this.mode = this.mode.kind === 'target' && this.mode.abilityId === b.id ? { kind: 'move' } : { kind: 'target', abilityId: b.id };
    }
    this.refresh();
  }

  /** Step back one level; false when there was nothing to step back from (Esc then opens the menu). */
  private cancel(): boolean {
    const was = this.mode;
    if (this.mode.kind === 'target' || (this.mode.kind === 'facing' && !this.state.acted)) sfx(this, 'ui_back');
    if (this.mode.kind === 'target' && this.mode.selected) this.mode = { kind: 'target', abilityId: this.mode.abilityId }; // back one step
    else if (this.mode.kind === 'target') this.mode = { kind: 'move' };
    else if (this.mode.kind === 'facing' && !this.state.acted) this.mode = { kind: 'move' };
    this.refresh();
    return this.mode !== was;
  }

  private async clickTile(p: Point): Promise<void> {
    const u = activeUnit(this.state);
    if (!u || u.team !== 'player') return;
    if (this.mode.kind === 'move' && !this.state.moved) {
      const tree = pathTree(this.state, u);
      if (samePoint(p, u.pos) || !tree.has(key(p)) || occupant(this.state, p)) return;
      this.mode = { kind: 'busy' };
      const path = moveUnit(this.state, u.id, p);
      await this.animateMove(u, path);
      this.mode = { kind: 'move' };
      this.refresh();
    } else if (this.mode.kind === 'target') {
      const abilityId = this.mode.abilityId;
      if (!targetTiles(this.state, u, abilityId).some((t) => samePoint(t, p))) return;
      // Two-step targeting: a click on a new target selects it; a click on the selection confirms.
      if (!this.mode.selected || !samePoint(this.mode.selected, p)) { this.selectTarget(p); return; }
      this.mode = { kind: 'busy' };
      await this.performAbility(u, abilityId, p);
      if (this.state.winner) return this.finish();
      this.mode = { kind: 'facing', facing: u.facing };
      this.refresh();
    } else if (this.mode.kind === 'facing') {
      this.confirmFacing();
    }
  }

  private confirmFacing(): void {
    if (this.mode.kind !== 'facing') return;
    endTurn(this.state, this.mode.facing);
    this.mode = { kind: 'busy' };
    this.nextTurn();
  }

  // ---------- turn flow ----------

  private nextTurn(): void {
    if (this.state.winner) return this.finish();
    const u = startNextTurn(this.state);
    if (!u) return this.finish();
    this.rebuildButtons();
    this.followActive();
    if (u.team === 'enemy') {
      this.mode = { kind: 'busy' };
      this.refresh();
      void this.runEnemy(u);
    } else {
      this.mode = { kind: 'move' };
      this.refresh();
    }
  }

  private async runEnemy(u: Unit): Promise<void> {
    await this.wait(350);
    const plan = planTurn(this.state, u);
    console.info('[oathbound] ai', JSON.stringify(plan));
    if (!samePoint(plan.moveTo, u.pos)) {
      const path = moveUnit(this.state, u.id, plan.moveTo);
      await this.animateMove(u, path);
    }
    if (plan.action) {
      const a = ABILITIES[plan.action.abilityId]!;
      const preview = previewAction(this.state, u, plan.action.abilityId, plan.action.target);
      for (const p of a.type === 'self' ? [u.pos] : areaTiles(this.state, a, u.pos, plan.action.target)) {
        const g = this.overlays[p.y * this.state.map.width + p.x]!;
        g.fillStyle(COLORS.range, 0.45).fillPoints(topDiamond(this.iso, p.x, p.y, heightAt(this.state.map, p)), true);
      }
      this.showPanel(this.previewView(preview));
      await this.wait(700);
      await this.performAbility(u, plan.action.abilityId, plan.action.target);
      if (this.state.winner) return this.finish();
    }
    endTurn(this.state, plan.facing);
    await this.wait(250);
    this.nextTurn();
  }

  private async performAbility(u: Unit, abilityId: string, target: Point): Promise<void> {
    const cast = abilitySound(abilityId);
    if (cast) sfx(this, cast);
    // Attack pose toward the target before the result lands (pack attack strip, 4 frames).
    const av = this.views.get(u.id);
    if (av?.sprite && !samePoint(target, u.pos)) {
      this.pose(u, av, 'attack', screenDir(this.iso, { x: Math.sign(target.x - u.pos.x), y: Math.sign(target.y - u.pos.y) }));
      await this.wait(260);
    }
    const results = useAbility(this.state, u.id, abilityId, target);
    for (const r of results) {
      const tv = this.views.get(r.unitId);
      const tu = getUnit(this.state, r.unitId);
      if (tv?.sprite && r.hit && r.damage > 0 && tu.status === 'ok') {
        this.pose(tu, tv, 'damage');
        this.time.delayedCall(350, () => { if (tu.status === 'ok') this.pose(tu, tv, 'idle'); });
      }
    }
    if (isAttack(abilityId) && results.length) {
      const hit = results.some((r) => r.hit && r.damage > 0);
      this.time.delayedCall(cast ? 180 : 0, () => sfx(this, hit ? 'atk_hit' : 'atk_miss'));
    }
    this.refresh();
    for (const r of results) {
      const t = getUnit(this.state, r.unitId);
      if (r.pushedTo) this.placeUnit(t, t.pos);
      const label = !r.hit ? 'MISS' : r.heal ? `+${r.heal}` : r.damage ? `-${r.damage}` : abilityLabel(abilityId);
      this.floatText(t, label, !r.hit ? '#e5e7eb' : r.heal ? '#4ade80' : r.damage ? '#f87171' : '#f5c451');
    }
    await this.wait(600);
  }

  private finish(): void {
    this.refresh();
    sting(this, this.state.winner === 'player' ? 'mus_victory_sting' : 'mus_defeat_sting');
    console.info('[oathbound] battle end', JSON.stringify({ winner: this.state.winner, turns: this.state.turnNumber, seed: this.state.seed }));
    this.time.delayedCall(1200, () => this.scene.start('Results', { state: this.state }));
  }

  // ---------- animation helpers ----------

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.time.delayedCall(ms, r));
  }

  private async animateMove(u: Unit, path: Point[]): Promise<void> {
    const v = this.views.get(u.id)!;
    let prev = path.length ? { ...path[0]! } : u.pos;
    for (const p of path) {
      const c = tileCenter(this.iso, p.x, p.y, heightAt(this.state.map, p));
      if (!samePoint(p, prev)) this.pose(u, v, 'walk', screenDir(this.iso, { x: p.x - prev.x, y: p.y - prev.y }));
      v.root.setDepth(Math.max(depthOf(this.iso, p.x, p.y), depthOf(this.iso, prev.x, prev.y)) * 10 + 5);
      await new Promise<void>((r) => this.tweens.add({ targets: [v.root, v.outline, v.sigilRoot], x: c.x, y: c.y, duration: 120, onComplete: () => r() }));
      prev = p;
    }
    this.placeUnit(u, u.pos);
    this.refresh();
  }

  private floatText(u: Unit, s: string, color: string): void {
    const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
    const t = text(this, c.x, c.y - 60, s, 20, color).setOrigin(0.5).setDepth(900).setStroke('#000000', 4);
    this.tweens.add({ targets: t, y: t.y - 30, alpha: 0, duration: 1100, delay: 200, onComplete: () => t.destroy() });
  }

  // ---------- log, debug and QA hooks ----------

  private flushEvents(): void {
    const events = this.state.events;
    for (; this.eventCursor < events.length; this.eventCursor++) {
      const e = events[this.eventCursor]!;
      const line = this.describe(e);
      if (line) { this.log.push(line); this.logTimes.push(this.time.now); }
      this.react(e);
      if (e.type === 'ability') {
        console.info('[oathbound] action', JSON.stringify({
          turn: this.state.turnNumber, actor: e.unitId, ability: e.abilityId, target: e.target, from: e.preview.from,
          preview: e.preview.victims, results: e.results,
        }));
      }
    }
    this.log = this.log.slice(-14);
    this.logTimes = this.logTimes.slice(-14);
    this.renderLog();
  }

  // ---------- barks, oaths, reactions and banners (Writing's strings) ----------

  private bubbles = new Map<string, Phaser.GameObjects.Text>();

  /** A speech bubble above a unit, in world space so it follows pan, zoom and rotation. */
  private say(unitId: string, line: string, ms = 1800): void {
    const u = this.state.units.find((x) => x.id === unitId);
    if (!u || u.status === 'lost') return;
    this.bubbles.get(unitId)?.destroy();
    const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
    const b = text(this, c.x + 14, c.y - 52, line, 12, '#111318').setOrigin(0, 1).setDepth(960)
      .setBackgroundColor('#f5f0e1').setPadding(6, 4, 6, 4).setWordWrapWidth(220).setAlign('center');
    this.bubbles.set(unitId, b);
    this.tweens.add({ targets: b, alpha: 0, delay: ms, duration: 300, onComplete: () => { b.destroy(); if (this.bubbles.get(unitId) === b) this.bubbles.delete(unitId); } });
  }

  /** One random bark line for a player unit. `force` skips the chance roll; a short cooldown stops spam. */
  private barkFor(unitId: string, kind: string, force = false, chance = 0.4): void {
    const now = this.time.now;
    if (!force && (this.barkRand() > chance || now - (this.lastBarkAt[unitId] ?? -1e9) < 4000)) return;
    const line = bark(unitId, kind, this.barkRand);
    if (!line) return;
    this.lastBarkAt[unitId] = now;
    this.say(unitId, line);
  }

  private banner(s: string, color: string): void {
    const sc = this.safeCentre();
    const b = text(this, sc.x, sc.y, s, 40, color).setOrigin(0.5).setDepth(2500).setStroke('#000000', 6).setAlpha(0);
    this.tweens.add({ targets: b, alpha: 1, duration: 200, yoyo: true, hold: 900, onComplete: () => b.destroy() });
  }

  private react(e: BattleEvent): void {
    const isPlayer = (id: string) => this.state.units.find((u) => u.id === id)?.team === 'player';
    const reaction = (id: string, vow: string, kind: string) => {
      const line = lookup(`vows.${vow}.reaction.${id}.${kind}`);
      if (typeof line === 'string') this.say(id, line, 2400);
    };
    switch (e.type) {
      case 'turnStart':
        if (isPlayer(e.unitId) && this.mode.kind !== 'deploy') sfx(this, 'unit_select');
        break;
      case 'move':
        sfx(this, 'unit_move');
        break;
      case 'ability':
        if (isPlayer(e.unitId)) this.barkFor(e.unitId, 'attack');
        for (const r of e.results) if (r.hit && r.damage > 0 && isPlayer(r.unitId) && getUnit(this.state, r.unitId).status === 'ok') this.barkFor(r.unitId, 'hit', false, 0.5);
        break;
      case 'downed':
        this.time.delayedCall(220, () => sfx(this, 'unit_down'));
        if (isPlayer(e.unitId)) this.barkFor(e.unitId, 'downed', true);
        else if (e.by && isPlayer(e.by)) this.barkFor(e.by, 'kill', true);
        break;
      case 'revived':
        if (isPlayer(e.unitId)) this.barkFor(e.unitId, 'revived', true);
        break;
      case 'vowProgress':
        // Held: the guard is done and the vow waits for battle end. No dedicated sound yet; a softer vow_sworn.
        if (e.vowId === 'bulwark' && e.progress >= e.goal) { reaction(e.unitId, e.vowId, 'held'); sfx(this, 'vow_sworn', 0.8); }
        break;
      case 'vowFulfilled':
        // Bulwark is judged at battle end: its reaction belongs to the Reckoning.
        if (!this.state.winner) { reaction(e.unitId, e.vowId, 'kept'); this.banner(t('ui.banner.vowKept'), '#f5c451'); sfx(this, 'vow_kept'); }
        break;
      case 'vowBroken':
        reaction(e.unitId, e.vowId, 'broken');
        sfx(this, 'vow_broken');
        this.banner(t('ui.banner.vowBroken'), '#a78bfa');
        break;
      default:
    }
  }

  private describe(e: BattleEvent): string {
    const n = (id: string) => getUnit(this.state, id).name;
    switch (e.type) {
      case 'turnStart': return `— ${n(e.unitId)}'s turn`;
      case 'ability': {
        const parts = e.results.map((r) => `${n(r.unitId)} ${!r.hit ? 'miss' : r.heal ? `+${r.heal}` : r.damage ? `-${r.damage}` : 'ok'}`);
        return `${n(e.unitId)}: ${abilityLabel(e.abilityId)} → ${parts.join(', ')}`;
      }
      case 'downed': return `${n(e.unitId)} is down!`;
      case 'revived': return `${n(e.unitId)} is back up`;
      case 'lost': return `${n(e.unitId)} is lost`;
      case 'morale': return `${t(e.team === 'player' ? 'ui.morale.squad' : 'ui.morale.foe')} morale ${e.delta > 0 ? '+' : ''}${e.delta} (${e.reason})`;
      case 'vowSworn': return `${n(e.unitId)} swears ${vowDef(e.vowId).name}`;
      case 'vowProgress': return `${n(e.unitId)}'s vow: ${e.progress}/${e.goal}`;
      case 'vowFulfilled': return `${n(e.unitId)} keeps ${vowDef(e.vowId).name}!`;
      case 'vowBroken': return `${n(e.unitId)} breaks ${vowDef(e.vowId).name} (${e.cause})`;
      case 'vowFrozen': return `${n(e.unitId)}'s vow is frozen`;
      case 'intercept': return `${n(e.unitId)} guards ${n(e.protectedId)}`;
      case 'battleEnd': return e.winner === 'player' ? 'Victory!' : 'Defeat…';
      default: return '';
    }
  }

  private toggleDebug(): void {
    this.debug = !this.debug;
    this.debugText.setVisible(this.debug);
    this.renderLog();
    this.refresh();
  }

  private debugDump(preview: ActionPreview | null): string {
    const s = this.state;
    const rows = s.units.map((u) => {
      const st = effectiveStats(s, u);
      const cds = Object.entries(u.cooldowns).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
      return `${u.id.padEnd(8)} ${u.status.padEnd(6)} hp ${String(u.hp).padStart(2)}/${u.base.hp} ct ${String(u.ct).padStart(3)}\n` +
        `   (${u.pos.x},${u.pos.y},h${heightAt(s.map, u.pos)}) ${u.facing} a${st.atk} d${st.def} r${st.res} mv${st.move} ${cds}`;
    });
    const pv = preview ? `\npreview\n${preview.victims.map((v) => ` ${v.unitId} hit ${v.hit} dmg ${v.damage} ${v.side} dh ${v.heightDiff}`).join('\n')}` : '';
    return [`seed ${s.seed}  turn ${s.turnNumber}  morale P${s.morale.player} E${s.morale.enemy}`, ...rows].join('\n') + pv;
  }

  private screenPointFor(t: Point): Vec | null {
    const c = tileCenter(this.iso, t.x, t.y, heightAt(this.state.map, t));
    for (let dy = -46; dy <= 14; dy += 2) {
      for (let dx = -28; dx <= 28; dx += 4) {
        const p = { x: c.x + dx, y: c.y + dy };
        // Require a small margin so a click there lands on the tile, not on an edge.
        const ok = [[0, 0], [3, 3], [-3, 3], [3, -3], [-3, -3]].every(([ox, oy]) => {
          const hit = this.pick({ x: p.x + ox!, y: p.y + oy! });
          return !!hit && samePoint(hit, t);
        });
        if (!ok) continue;
        // Back to screen space: QA clicks with page coordinates.
        const cam = this.cameras.main;
        const sx = (p.x - cam.scrollX - cam.width / 2) * cam.zoom + cam.width / 2;
        const sy = (p.y - cam.scrollY - cam.height / 2) * cam.zoom + cam.height / 2;
        const ls = layoutScale();
        const L = layoutSize();
        const lx = sx / ls / LP, ly = sy / ls / LP, cr = this.camRect;
        const inCam = lx >= cr.x && lx <= cr.x + cr.w && ly >= cr.y && ly <= cr.y + cr.h;
        if (ly > 46 && ly < screenLp().h - 96 && sx >= 0 && sx / ls <= L.w && !inCam) {
          // Canvas pixels to page pixels (the canvas is shown at 1/devicePixelRatio and letterboxed).
          const r = this.game.canvas.getBoundingClientRect();
          return { x: r.left + (sx * r.width) / this.game.canvas.width, y: r.top + (sy * r.height) / this.game.canvas.height };
        }
      }
    }
    return null;
  }

  private exposeForQa(): void {
    const scene = this;
    (window as unknown as Record<string, unknown>).oathbound = {
      scene,
      get state() { return scene.state; },
      preview: (actorId: string, abilityId: string, x: number, y: number) => previewAction(this.state, getUnit(this.state, actorId), abilityId, { x, y }),
      /** A screen point that picks tile (x, y), or null if it is fully hidden. For click automation. */
      screenPointFor: (x: number, y: number) => this.screenPointFor({ x, y }),
      /** Turn the view a quarter turn (1 = clockwise, -1 = counter-clockwise). */
      rotate: (dir = 1) => this.rotateView(dir),
      resetCamera: () => this.resetCamera(),
      get camera() { const c = scene.cameras.main; return { rot: scene.iso.rot ?? 0, zoom: c.zoom / layoutScale(), scale: layoutScale() * 2, scrollX: c.scrollX, scrollY: c.scrollY }; },
      /** What the enemy AI would do with this unit; QA uses it for automated runs. */
      plan: (unitId: string) => planTurn(this.state, getUnit(this.state, unitId)),
      /** What the active unit could hit from (x, y) if it moved there (#21). */
      movePreview: (x: number, y: number) => {
        const u = activeUnit(this.state);
        return u ? movePreview(this.state, u, { x, y }) : null;
      },
    };
  }
}

/** Move preview palette (UX §1). */
const PV = { bone: 0xede6d3, ring: 0xc0533f };

/** Two-letter stand-in for the ability icon until Art's icons land. */
function abilityCode(id: string): string {
  const words = abilityLabel(id).split(' ');
  return words.length > 1 ? words.map((w) => w[0]).join('') : words[0]!.slice(0, 2);
}

function sideTag(t: Threat): string {
  if (t.braced) return 'Front (Braced)';
  return t.side[0]!.toUpperCase() + t.side.slice(1);
}

function describeEffect(abilityId: string): string {
  const a = ABILITIES[abilityId];
  if (!a) return '';
  if (a.buff) return [a.buff.def ? `+${a.buff.def} Def` : '', a.buff.res ? `+${a.buff.res} Res` : '', a.buff.allFront ? 'all hits count as front' : ''].filter(Boolean).join(', ');
  if (a.morale) return `+${a.morale} squad morale`;
  return abilityLabel(abilityId);
}
