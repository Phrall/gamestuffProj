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
import { COLORS, FONT } from './theme';
import { abilityName, abilityParams, abilityShort, bark, lookup, moraleParams, scene, t, unitName, unitShort, vowName, vowParams } from '../data/strings';
import { playDialogue } from './dialogue';
import { mulberry32 } from '../core/rng';

type Mode =
  | { kind: 'busy' }
  | { kind: 'deploy' }
  | { kind: 'move' }
  | { kind: 'target'; abilityId: string }
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
}

const ENEMY_GLYPH: Record<string, string> = { captain: 'C', spearA: 'P1', spearB: 'P2', archerA: 'A1', archerB: 'A2', binder: 'O' };
/** Board token: player units by name initial (QA #15), enemies by role and number. */
const glyphFor = (u: Unit): string => (u.team === 'player' ? u.name[0]! : ENEMY_GLYPH[u.id] ?? u.name[0]!);
/** Short name for timeline chips; numbered when two units share a name. */
const shortName = (u: Unit): string => {
  const n = u.name.replace('Court ', '');
  const tag = ENEMY_GLYPH[u.id]?.match(/\d$/)?.[0];
  return unitShort(u.id, tag ? `${n} ${tag}` : n);
};

/** Ability display name from Writing's strings (falls back to the id, spaced out). */
export const abilityLabel = (id: string): string => {
  const n = abilityName(id);
  return n !== id ? n : id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
};

const text = (scene: Phaser.Scene, x: number, y: number, s: string, size = 14, color: string = COLORS.text) =>
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
  private mapGfx: Phaser.GameObjects.Graphics[] = [];
  private barkRand: () => number = Math.random;
  private lastBarkAt: Record<string, number> = {};
  private wasShaken = false;
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private sorted = new WeakSet<Phaser.GameObjects.GameObject>();
  private drag: { x: number; y: number; moved: boolean; button: number } | null = null;
  private compass!: Phaser.GameObjects.Graphics;
  /** Move preview for the hovered tile (#21), cached per tile for the current turn. */
  private movePv: MovePreview | null = null;
  private movePvCache = new Map<string, MovePreview>();
  private chips: Phaser.GameObjects.GameObject[] = [];

  private timeline!: Phaser.GameObjects.Container;
  private moraleText!: Phaser.GameObjects.Text;
  private unitPanel!: Phaser.GameObjects.Text;
  private previewPanel!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private logText!: Phaser.GameObjects.Text;
  private debugText!: Phaser.GameObjects.Text;
  private buttons: { id: string; bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }[] = [];
  private log: string[] = [];
  private eventCursor = 0;

  constructor() { super('Battle'); }

  create(): void {
    const seedParam = Number(new URLSearchParams(window.location.search).get('seed'));
    const seed = Number.isInteger(seedParam) && seedParam > 0 ? seedParam : (Date.now() % 1_000_000) + 1;
    const setup = millFordSetup();
    this.state = createBattle(setup, seed);
    for (const u of this.state.units) u.name = unitName(u.id, u.name);
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

    this.setupCameras();
    this.drawMap();
    for (const u of this.state.units) this.views.set(u.id, this.makeUnitView(u));
    this.drawUi();
    this.drawCameraButtons();
    this.bindInput();
    this.exposeForQa();
    this.showDeploy(seed);
  }

  // ---------- deploy and swear (§9) ----------

  private vowChoice: Record<string, VowId | null> = {};
  private deployUi: Phaser.GameObjects.GameObject[] = [];

  private showDeploy(seed: number): void {
    this.mode = { kind: 'busy' };
    this.refresh();
    const order: (VowId | null)[] = [null, 'bulwark', 'loneBlade'];
    const draw = () => {
      for (const o of this.deployUi) o.destroy();
      this.deployUi = [];
      const add = <T extends Phaser.GameObjects.GameObject>(o: T) => { this.deployUi.push(o); return o; };
      add(this.add.rectangle(330, 122, 620, 460, COLORS.panel, 0.96).setOrigin(0).setStrokeStyle(2, COLORS.gold).setDepth(3000));
      add(text(this, 640, 140, t('ui.deploy.title'), 24, '#f5c451').setOrigin(0.5, 0).setDepth(3001));
      add(text(this, 640, 174, t('ui.deploy.subtitle'), 13, COLORS.textDim).setOrigin(0.5, 0).setDepth(3001));
      const chosen = [...new Set(Object.values(this.vowChoice).filter((v): v is VowId => !!v))];
      const notes = chosen.map((v) => `${vowName(v)}: ${t(`ui.vows.${v}.summary`, vowParams(v))} ${t(`ui.vows.${v}.breaks`, vowParams(v))}`);
      const notesY = 214 + this.state.units.filter((u) => u.team === 'player').length * 44;
      if (notes.length) add(text(this, 640, notesY, notes.join('\n\n'), 13, COLORS.textDim).setOrigin(0.5, 0).setDepth(3001).setWordWrapWidth(590).setAlign('center'));
      this.state.units.filter((u) => u.team === 'player').forEach((u, i) => {
        const y = 206 + i * 44;
        const choice = this.vowChoice[u.id] ?? null;
        add(text(this, 360, y + 8, `${u.name.padEnd(7)} ${CLASSES[u.classId!]!.name}`, 16).setDepth(3001));
        const btn = add(this.add.rectangle(600, y, 320, 36, choice ? 0x3b2f12 : 0x1f2937).setOrigin(0).setStrokeStyle(1, choice ? COLORS.gold : COLORS.panelEdge).setDepth(3001).setInteractive({ useHandCursor: true }));
        const label = choice ? `${vowName(choice)}: ${t(`ui.vows.${choice}.progress`, vowParams(choice, 0))}` : t('ui.deploy.noVow');
        add(text(this, 612, y + 9, label, 14, choice ? '#f5c451' : COLORS.textDim).setDepth(3002));
        btn.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
          ev.stopPropagation();
          this.vowChoice[u.id] = order[(order.indexOf(choice) + 1) % order.length]!;
          draw();
        });
      });
      const go = add(this.add.rectangle(540, 524, 200, 40, 0x14532d).setOrigin(0).setStrokeStyle(2, 0x4ade80).setDepth(3001).setInteractive({ useHandCursor: true }));
      add(text(this, 640, 544, t('ui.deploy.begin'), 18).setOrigin(0.5).setDepth(3002));
      go.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); begin(); });
    };
    const begin = () => {
      if (this.mode.kind !== 'deploy') return;
      for (const o of this.deployUi) o.destroy();
      this.deployUi = [];
      for (const [id, vow] of Object.entries(this.vowChoice)) if (vow) swearVow(this.state, id, vow);
      this.input.keyboard?.off('keydown-ENTER', begin);
      console.info('[oathbound] battle start', JSON.stringify({ seed, map: this.state.map.id, vows: this.vowChoice }));
      this.mode = { kind: 'busy' };
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

  private makeUnitView(u: Unit): UnitView {
    const root = this.add.container(0, 0);
    const body = this.add.graphics();
    const nub = this.add.graphics();
    const glyph = text(this, 0, -22, glyphFor(u), 14, '#111318').setOrigin(0.5);
    const hp = this.add.graphics();
    const sigil = this.add.graphics();
    const sigilText = text(this, -14, -68, '', 12, '#111318').setOrigin(0.5);
    root.add([nub, body, glyph, hp, sigil, sigilText]);
    const outline = this.add.graphics().setDepth(898);
    const view = { root, body, glyph, hp, nub, sigil, sigilText, outline };
    this.placeUnit(u, u.pos, view);
    return view;
  }

  private placeUnit(u: Unit, p: Point, view = this.views.get(u.id)): void {
    if (!view) return;
    const c = tileCenter(this.iso, p.x, p.y, heightAt(this.state.map, p));
    view.root.setPosition(c.x, c.y).setDepth(depthOf(this.iso, p.x, p.y) * 10 + 5);
    view.outline.setPosition(c.x, c.y);
  }

  private drawUnit(u: Unit): void {
    const v = this.views.get(u.id);
    if (!v) return;
    if (u.status === 'lost') {
      // Death animation (#20): sink and fade out over ~400 ms, then leave the board.
      v.outline.clear();
      if (v.root.visible && !this.tweens.isTweening(v.root)) {
        this.tweens.add({ targets: v.root, alpha: 0, y: v.root.y + 10, duration: 400, delay: 250, onComplete: () => v.root.setVisible(false) });
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
    if (u.status === 'downed') {
      v.body.fillStyle(color).fillEllipse(0, -4, 30, 12);
      v.glyph.setY(-4).setText('☠');
    } else {
      v.body.fillStyle(color).fillRoundedRect(-13, -38, 26, 36, 5);
      v.body.lineStyle(active || lit ? 3 : 1, active ? COLORS.gold : lit ? COLORS.hover : 0x000000, 1).strokeRoundedRect(-13, -38, 26, 36, 5);
      v.glyph.setY(-20).setText(glyphFor(u));
    }
    v.nub.clear();
    if (u.status === 'ok') {
      const d = screenDir(this.iso, DIRS[u.facing]);
      v.nub.fillStyle(0xffffff, 0.9).fillTriangle(d.x * 22, d.y * 22, d.x * 10 - d.y * 8, d.y * 10 + d.x * 4, d.x * 10 + d.y * 8, d.y * 10 - d.x * 4);
    }
    this.drawSigil(u, v);
    v.hp.clear();
    if (u.status !== 'ok') return;
    const frac = Math.max(0, u.hp / u.base.hp);
    v.hp.fillStyle(0x000000, 0.7).fillRect(-15, -46, 30, 5);
    v.hp.fillStyle(frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfacc15 : 0xef4444).fillRect(-15, -46, 30 * frac, 5);
  }

  /** Vow sigil (UX board 4): gold while intact or kept, cracked violet when broken, dim when frozen or lapsed. */
  private drawSigil(u: Unit, v: UnitView): void {
    v.sigil.clear();
    const vow = this.state.vows[u.id];
    if (!vow || u.status === 'lost') { v.sigilText.setText(''); return; }
    // Sits up and to the left of the token: an iso neighbour is 32px right and 16px down,
    // so adjacent sigils no longer overlap (QA #16).
    const y = u.status === 'downed' ? -26 : -68;
    const x = -14;
    const dim = vow.status === 'lapsed';
    // v1.7 "Held": goal met but still breakable until battle end (UX sigil board).
    const held = vow.status === 'intact' && vow.progress >= vow.goal;
    // Frozen (unit downed with the vow intact): last state at 40% with a pause bar; nothing can break it.
    const frozen = vow.frozen && vow.status === 'intact';
    const color = vow.status === 'broken' ? COLORS.violet : dim ? COLORS.downed : held ? 0xf3e3b5 : COLORS.gold;
    const d = [{ x, y: y - 14 }, { x: x + 14, y }, { x, y: y + 14 }, { x: x - 14, y }];
    v.sigil.setAlpha(frozen ? 0.4 : 1);
    v.sigilText.setAlpha(frozen ? 0.4 : 1);
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
      v.sigilText.setPosition(x, y).setText(vow.status === 'fulfilled' ? '✓' : `${vow.progress}/${vow.goal}`);
    }
    // Pips (UX): one per goal step, filled as progress grows.
    for (let i = 0; i < vow.goal && vow.status !== 'broken'; i++) {
      const px = x + (i - (vow.goal - 1) / 2) * 8;
      v.sigil.fillStyle(i < vow.progress ? color : 0x000000, i < vow.progress ? 1 : 0.7).fillCircle(px, y + 19, 3);
    }
  }

  // ---------- UI ----------

  private drawUi(): void {
    this.timeline = this.add.container(0, 0).setDepth(1000);
    this.moraleText = text(this, 1270, 12, '', 14).setOrigin(1, 0).setDepth(1000).setInteractive();
    this.moraleText.on('pointerover', () => {
      const tier = teamMorale(this.state, 'player').name.toLowerCase();
      this.hint.setText(`${t(`ui.morale.${tier}.name`)}: ${t(`ui.morale.${tier}.tooltip`, moraleParams(tier))}`);
    });
    this.moraleText.on('pointerout', () => this.refreshHint());
    this.logText = text(this, 12, 96, '', 12, COLORS.textDim).setDepth(1000).setWordWrapWidth(280);
    // Left column, in place of the log, so it never covers the map (QA #14).
    this.debugText = text(this, 8, 96, '', 10, '#a7f3d0').setDepth(1001).setBackgroundColor('#000000cc').setVisible(false);

    const panel = (x: number, w: number) => this.add.rectangle(x, 548, w, 162, COLORS.panel).setOrigin(0).setStrokeStyle(1, COLORS.panelEdge).setDepth(999);
    panel(10, 380);
    panel(400, 480);
    panel(890, 380);
    this.unitPanel = text(this, 22, 558, '', 14).setDepth(1000).setLineSpacing(4);
    this.previewPanel = text(this, 902, 558, '', 14).setDepth(1000).setLineSpacing(4).setWordWrapWidth(360);
    this.hint = text(this, 590, 528, '', 14, COLORS.textDim).setOrigin(0.5).setDepth(1000).setWordWrapWidth(700).setAlign('center');
    text(this, 12, 700, 'Drag/arrows: pan   Wheel: zoom   Q/E: rotate   C: center   R: reset   Esc: cancel   1-6: actions   Tab/Enter: pick   W: wait   D: debug', 11, '#6b7280').setOrigin(0, 1).setDepth(1000);
  }

  private rebuildButtons(): void {
    for (const b of this.buttons) { b.bg.destroy(); b.label.destroy(); }
    this.buttons = [];
    const u = activeUnit(this.state);
    if (!u || u.team !== 'player') return;
    const ids = u.abilities.filter((id) => ABILITIES[id]?.type !== 'passive');
    ids.push('wait');
    ids.forEach((id, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 412 + col * 156;
      const y = 560 + row * 48;
      const bg = this.add.rectangle(x, y, 148, 40, 0x1f2937).setOrigin(0).setStrokeStyle(1, COLORS.panelEdge).setDepth(1000).setInteractive({ useHandCursor: true });
      const label = text(this, x + 10, y + 11, '', 14).setDepth(1001);
      bg.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); this.pressAction(i); });
      if (id !== 'wait') {
        bg.on('pointerover', () => this.hint.setText(`${abilityLabel(id)}: ${t(`ui.abilities.${id}.tooltip`, abilityParams(id, effectiveStats(this.state, u).mag))}`));
        bg.on('pointerout', () => this.refreshHint());
      }
      this.buttons.push({ id, bg, label });
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
        if (cd > 0) suffix = ` (${cd})`;
        if (u.usedOnce.includes(b.id)) suffix = ' (used)';
        enabled &&= !this.state.acted && abilityReady(u, b.id) && targetTiles(this.state, u, b.id).length > 0;
      }
      const selected = this.mode.kind === 'target' && this.mode.abilityId === b.id;
      b.label.setText(`${i + 1} ${b.id === 'wait' ? (this.state.moved || this.state.acted ? t('ui.turn.endTurn') : t('ui.turn.wait')) : abilityShort(b.id)}${suffix}`);
      b.label.setColor(enabled ? COLORS.text : '#4b5563');
      b.bg.setFillStyle(selected ? 0x374151 : 0x1f2937).setStrokeStyle(selected ? 2 : 1, selected ? COLORS.gold : COLORS.panelEdge);
    });
  }

  private refreshTimeline(): void {
    this.timeline.removeAll(true);
    const active = this.state.activeId ?? undefined;
    const entries = forecast(this.state.units, 8, active);
    const w = 96;
    const x0 = 640 - (entries.length * (w + 6)) / 2;
    this.timeline.add(text(this, x0 - 12, 30, 'NEXT', 12, COLORS.textDim).setOrigin(1, 0.5));
    entries.forEach((e, i) => {
      const u = getUnit(this.state, e.unitId);
      const x = x0 + i * (w + 6);
      const lit = this.hoverUnitId === u.id;
      const bg = this.add.rectangle(x, 12, w, 36, u.team === 'player' ? 0x0c4a6e : 0x7f1d1d).setOrigin(0)
        .setStrokeStyle(i === 0 || lit ? 2 : 1, i === 0 ? COLORS.gold : lit ? COLORS.hover : COLORS.panelEdge)
        .setInteractive();
      bg.on('pointerover', () => { this.hoverUnitId = u.id; this.refreshUnits(); this.refreshTimeline(); });
      bg.on('pointerout', () => { this.hoverUnitId = null; this.refreshUnits(); this.refreshTimeline(); });
      // Clicking a chip points at that unit's tile, so units hidden on the board can still be targeted.
      bg.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation();
        if (u.status === 'lost') return;
        const already = this.hover && samePoint(this.hover, u.pos);
        this.setHover({ ...u.pos });
        if (already && this.mode.kind === 'target') void this.clickTile(u.pos);
      });
      const t = text(this, x + w / 2, 30, `${e.downed ? '☠ ' : ''}${shortName(u)}`, 12).setOrigin(0.5);
      this.timeline.add([bg, t]);
    });
    // Wait ghost (UX board): where the active unit would land if it waited (CT 40).
    const a = activeUnit(this.state);
    if (a && a.team === 'player' && !this.state.moved && !this.state.acted) {
      const ghost = forecast(this.state.units, 8, a.id, 40).findIndex((e, i) => i > 0 && e.unitId === a.id);
      if (ghost > 0) {
        const gx = x0 + ghost * (w + 6) + w / 2;
        this.timeline.add(text(this, gx, 54, `▲ ${t('ui.timeline.waitGhost')}`, 11, '#f5c451').setOrigin(0.5, 0));
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

  private unitSummary(u: Unit, title: string): string {
    const s = effectiveStats(this.state, u);
    const moraleMove = u.moraleMove ? ` (${u.moraleMove} Shaken)` : '';
    const mods = u.modifiers.map((m) => abilityLabel(m.source)).join(', ');
    const cls = u.classId ? CLASSES[u.classId]!.name : u.leader ? 'Leader' : 'Oathcourt';
    return [
      `${title}${u.name}  ·  ${cls}${u.status !== 'ok' ? `  ·  ${u.status.toUpperCase()} (${u.reviveCounter})` : ''}`,
      `HP ${u.hp}/${u.base.hp}   CT ${u.ct}   Facing ${u.facing} ${this.screenArrow(u.facing)}`,
      `Atk ${s.atk}  Mag ${s.mag}  Def ${s.def}  Res ${s.res}`,
      `Spd ${s.spd}  Move ${s.move}${moraleMove}  Jump ${s.jump}  Eva ${s.eva}`,
      mods ? `Effects: ${mods}` : '',
      this.vowLine(u),
    ].filter(Boolean).join('\n');
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

  private refreshPanels(preview: ActionPreview | null): void {
    const a = activeUnit(this.state);
    this.unitPanel.setText(a ? this.unitSummary(a, a.team === 'player' ? '▶ ' : 'Enemy turn: ') : '');
    if (preview) {
      this.previewPanel.setText(this.previewText(preview));
    } else if (this.movePv) {
      this.previewPanel.setText(this.movePreviewText(this.movePv));
    } else {
      const hu = this.hover ? occupant(this.state, this.hover) : this.hoverUnitId ? getUnit(this.state, this.hoverUnitId) : undefined;
      this.previewPanel.setText(hu && hu.id !== a?.id ? this.unitSummary(hu, '') : this.tileInfo());
    }
  }

  private tileInfo(): string {
    if (!this.hover) return '';
    const t = tileAt(this.state.map, this.hover);
    if (!t) return '';
    const kind = t.kind === 'ground' ? 'Ground' : t.kind === 'ford' ? 'Ford (costs 2)' : t.kind === 'water' ? 'Water (impassable)' : 'Boulder (impassable)';
    return `Tile ${this.hover.x},${this.hover.y}\n${kind}\nHeight ${t.height}`;
  }

  private previewText(p: ActionPreview): string {
    const lines = [abilityLabel(p.abilityId)];
    if (p.breaksVow) {
      const actor = getUnit(this.state, p.actorId);
      const vow = this.state.vows[actor.id];
      const ally = this.state.units.find((o) => o.id !== actor.id && o.team === actor.team && o.status === 'ok' && Math.abs(o.pos.x - p.from.x) + Math.abs(o.pos.y - p.from.y) === 1);
      lines.push(`⚠ ${t('ui.preview.breaksVow')}`);
      if (vow && ally) lines.push(`  ${t('ui.preview.breaksVowDetail', { vow: vowName(vow.vowId), ally: ally.name })}`);
    }
    if (p.interceptedBy) lines.push(`Guarded: ${getUnit(this.state, p.interceptedBy).name} takes the hit`);
    for (const v of p.victims) {
      const u = getUnit(this.state, v.unitId);
      const tags = [t(`ui.preview.${v.side}`), v.heightDiff > 0 ? `${t('ui.preview.highGround')} +${v.heightDiff}` : v.heightDiff < 0 ? `${t('ui.preview.lowGround')} ${v.heightDiff}` : ''].filter(Boolean).join(' · ');
      if (v.heal || v.revives) {
        lines.push(`${u.name}: ${v.revives ? 'REVIVE, ' : ''}heal ${v.heal}  HP ${u.hp} → ${v.hpAfter}`);
      } else if (v.damage) {
        lines.push(`${u.name}${u.team === getUnit(this.state, p.actorId).team ? ' (ally!)' : ''}`);
        lines.push(`  ${t('ui.preview.hit')} ${v.hit}%   ${t('ui.preview.damage')} ${v.damage}   ${t('ui.preview.hpAfter')} ${u.hp} → ${v.hpAfter}${v.downs ? '  ☠' : ''}`);
        lines.push(`  ${tags}${v.pushedTo ? ' · pushed' : ''}`);
      } else {
        lines.push(`${u.name}: ${describeEffect(p.abilityId)}`);
      }
    }
    lines.push('', 'Click to confirm');
    return lines.join('\n');
  }

  private refreshUnits(): void {
    for (const u of this.state.units) this.drawUnit(u);
  }

  /** Redraw tile highlights for the current mode and hover. */
  private refreshOverlays(): ActionPreview | null {
    for (const g of this.overlays) g.clear();
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
        for (const n of reachableTiles(this.state, u)) paint(n.pos, COLORS.move, 0.35);
        if (this.hover && tree.has(key(this.hover)) && !occupant(this.state, this.hover)) {
          for (const p of pathTo(tree, this.hover)) paint(p, COLORS.move, 0.55);
        }
        // Move preview (#21): from a reachable tile, or the unit's own tile ("stay and attack").
        const h = this.hover;
        if (h && (samePoint(h, u.pos) || (tree.has(key(h)) && !occupant(this.state, h)))) {
          this.movePv = this.movePreviewAt(u, h);
          paint(h, PV.bone, 0.75);
          for (const t of this.movePv.threats) {
            const e = getUnit(this.state, t.unitId);
            const g = this.overlays[e.pos.y * this.state.map.width + e.pos.x];
            const c = tileCenter(this.iso, e.pos.x, e.pos.y, heightAt(this.state.map, e.pos));
            g?.lineStyle(3, PV.ring, 1).strokeEllipse(c.x, c.y, 44, 20);
          }
        }
      } else if (this.mode.kind === 'target') {
        const a = ABILITIES[this.mode.abilityId]!;
        for (let y = 0; y < this.state.map.height; y++) {
          for (let x = 0; x < this.state.map.width; x++) {
            if (a.type !== 'self' && inRange(this.state, a, u.pos, { x, y })) paint({ x, y }, COLORS.range, 0.18);
          }
        }
        const valid = targetTiles(this.state, u, this.mode.abilityId);
        for (const p of valid) paint(p, COLORS.target, 0.9, true);
        if (this.hover && valid.some((p) => samePoint(p, this.hover!))) {
          for (const p of a.type === 'self' ? [u.pos] : areaTiles(this.state, a, u.pos, this.hover)) paint(p, COLORS.area, 0.45);
          preview = previewAction(this.state, u, this.mode.abilityId, this.hover);
        }
      } else if (this.mode.kind === 'facing') {
        for (const f of FACINGS) {
          const p = { x: u.pos.x + DIRS[f].x, y: u.pos.y + DIRS[f].y };
          if (tileAt(this.state.map, p)) paint(p, COLORS.gold, f === this.mode.facing ? 0.6 : 0.2);
        }
      }
    }
    if (this.hover && tileAt(this.state.map, this.hover)) paint(this.hover, COLORS.hover, 0.9, true);
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

  /** One chip per enemy in reach: ability codes in action-grid order (max 3, then +N), facing, skull. */
  private chipText(t: Threat): string {
    const codes = t.abilities.map((a) => (a.area ? `[${abilityCode(a.abilityId)}]` : abilityCode(a.abilityId)));
    const shown = codes.length > 3 ? [...codes.slice(0, 3), `+${codes.length - 3}`] : codes;
    return `${shown.join(' ')}  ${sideTag(t)}${t.canDown ? ' ☠' : ''}`;
  }

  private drawChips(): void {
    for (const o of this.chips) o.destroy();
    this.chips = [];
    const mp = this.movePv;
    if (!mp) return;
    const placed: Phaser.Geom.Rectangle[] = [];
    const lines = this.add.graphics().setDepth(949);
    this.chips.push(lines);
    for (const t of mp.threats) {
      const e = getUnit(this.state, t.unitId);
      const c = tileCenter(this.iso, e.pos.x, e.pos.y, heightAt(this.state.map, e.pos));
      const chip = text(this, c.x, c.y - 52, this.chipText(t), 11, '#fde2dc').setOrigin(0.5, 1).setDepth(950)
        .setBackgroundColor('#5a1f16').setPadding(4, 2, 4, 2);
      // Never stack chips: slide along the same row, right first, then left.
      let r = chip.getBounds();
      for (let i = 1; placed.some((q) => Phaser.Geom.Intersects.RectangleToRectangle(q, r)) && i < 12; i++) {
        const dx = (Math.ceil(i / 2) * (r.width + 4)) * (i % 2 ? 1 : -1);
        chip.setX(c.x + dx);
        r = chip.getBounds();
      }
      if (chip.x !== c.x) lines.lineStyle(1.5, PV.ring, 1).lineBetween(chip.x, r.bottom, c.x, c.y - 46);
      placed.push(r);
      this.chips.push(chip);
    }
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
    else if (this.mode.kind === 'target') h = 'Hover a target to preview, click to confirm. Right-click to cancel';
    else if (this.mode.kind === 'facing') h = 'Choose facing: click a gold tile or use arrow keys, Enter to confirm';
    this.hint.setText(h);
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
      if (e.key >= '1' && e.key <= '9') this.pressAction(Number(e.key) - 1);
      else if (e.key === 'w' || e.key === 'W') this.pressAction(this.buttons.findIndex((b) => b.id === 'wait'));
      else if (e.key === 'Escape') this.cancel();
      else if (e.key === 'd' || e.key === 'D') this.toggleDebug();
      else if (e.key === 'q' || e.key === 'Q') this.rotateView(-1);
      else if (e.key === 'e' || e.key === 'E') this.rotateView(1);
      else if (e.key === 'r' || e.key === 'R' || e.key === 'Home') this.resetCamera();
      else if (e.key === '+' || e.key === '=') this.zoomStep(1);
      else if (e.key === '-' || e.key === '_') this.zoomStep(-1);
      else if (e.key === 'c' || e.key === 'C') this.centerOnActive();
      else if (this.mode.kind !== 'facing' && e.key.startsWith('Arrow')) {
        const cam = this.cameras.main;
        const step = 48 / cam.zoom;
        if (e.key === 'ArrowLeft') cam.scrollX -= step;
        if (e.key === 'ArrowRight') cam.scrollX += step;
        if (e.key === 'ArrowUp') cam.scrollY -= step;
        if (e.key === 'ArrowDown') cam.scrollY += step;
        this.clampCamera();
      }
      else if (e.key === 'Tab') { e.preventDefault(); this.cycleTarget(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Enter' && (this.mode.kind === 'target' || this.mode.kind === 'move') && this.hover) void this.clickTile(this.hover);
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
    const main = this.cameras.main;
    main.setZoom(1).setScroll(0, 0);
    this.uiCam = this.cameras.add(0, 0, 1280, 720).setName('ui');
    this.events.on(Phaser.Scenes.Events.PRE_RENDER, this.sortCameras, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.events.off(Phaser.Scenes.Events.PRE_RENDER, this.sortCameras, this));
  }

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
    if (p.x >= 940 && p.y >= 492) return false; // camera control cluster
    return p.y > 66 && p.y < 540;
  }

  /** Zoom levels: 1 = the 2x pixel-art base, so these are 2x, 3x and 4x (UX §2). */
  private static ZOOMS = [1, 1.5, 2];

  private zoomStep(dir: number, at?: Phaser.Input.Pointer): void {
    const zs = BattleScene.ZOOMS;
    const cur = this.cameras.main.zoom;
    let i = zs.findIndex((z) => Math.abs(z - cur) < 0.01);
    if (i < 0) i = 0;
    const next = zs[Math.max(0, Math.min(zs.length - 1, i + dir))]!;
    if (next !== cur) this.zoomBy(next / cur, at);
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
    // Centre on the board area (between the timeline and the panels), not the whole canvas.
    const sx = w.x - c.width / 2;
    const sy = w.y - 20 - c.height / 2 - (303 - c.height / 2) / c.zoom;
    if (animate) this.tweens.add({ targets: c, scrollX: sx, scrollY: sy, duration: 300, ease: 'Sine.easeInOut' });
    else c.setScroll(sx, sy);
  }

  /** Auto-follow (UX §2): pan to the acting unit if it is off-screen or near a HUD panel. */
  private followActive(): void {
    const u = activeUnit(this.state);
    if (!u) return;
    const s = this.toScreen(tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos)));
    if (s.x < 120 || s.x > 1160 || s.y < 66 + 120 || s.y > 540 - 60) this.centerOnActive(true);
  }

  private zoomBy(f: number, at?: Phaser.Input.Pointer): void {
    // Keep the world point under the pointer fixed. Worked out by hand because the
    // camera matrix only updates at render time.
    const cam = this.cameras.main;
    const sx = at?.x ?? cam.width / 2;
    const sy = at?.y ?? cam.height / 2;
    const wx = (sx - cam.width / 2) / cam.zoom + cam.width / 2 + cam.scrollX;
    const wy = (sy - cam.height / 2) / cam.zoom + cam.height / 2 + cam.scrollY;
    const z = Phaser.Math.Clamp(cam.zoom * f, 0.6, 2.2);
    cam.setZoom(z);
    cam.scrollX = wx - (sx - cam.width / 2) / z - cam.width / 2;
    cam.scrollY = wy - (sy - cam.height / 2) / z - cam.height / 2;
    this.clampCamera();
  }

  private resetCamera(): void {
    this.cameras.main.setZoom(1).setScroll(0, 0);
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
    if (!g) return;
    const cx = 1270 - 24 - 6 * 44 - 10 + 22 + 44; // second slot
    const cy = 514;
    const d = screenDir(this.iso, DIRS.N);
    const len = Math.hypot(d.x, d.y);
    const nx = d.x / len, ny = d.y / len;
    g.clear();
    g.fillStyle(0x1f2937).fillCircle(cx, cy, 14).lineStyle(1, COLORS.panelEdge).strokeCircle(cx, cy, 14);
    g.fillStyle(0xef4444).fillTriangle(cx + nx * 11, cy + ny * 11, cx - ny * 4, cy + nx * 4, cx + ny * 4, cy - nx * 4);
    g.fillStyle(0x9ca3af).fillTriangle(cx - nx * 9, cy - ny * 9, cx - ny * 4, cy + nx * 4, cx + ny * 4, cy - nx * 4);
    this.compassLabel?.setPosition(cx + nx * 18, cy + ny * 18);
  }
  private compassLabel?: Phaser.GameObjects.Text;

  /** Camera cluster, bottom right above the target panel (UX §2): Q, compass, E | −, +, C. */
  private drawCameraButtons(): void {
    const x0 = 1270 - 24 - 6 * 44 - 10;
    this.add.rectangle(x0 - 6, 488, 6 * 44 + 10 + 12, 52, COLORS.panel, 0.92).setOrigin(0).setStrokeStyle(1, COLORS.panelEdge).setDepth(999);
    const items: ([string, string, () => void] | null)[] = [
      ['⟲', t('ui.camera.rotateLeft'), () => this.rotateView(-1)], null, ['⟳', t('ui.camera.rotateRight'), () => this.rotateView(1)],
      ['−', `${t('ui.camera.zoomOut')} (-)`, () => this.zoomStep(-1)], ['+', `${t('ui.camera.zoomIn')} (+)`, () => this.zoomStep(1)], ['◎', t('ui.camera.center'), () => this.centerOnActive(true)],
    ];
    items.forEach((it, i) => {
      if (!it) return;
      const [label, tip, fn] = it;
      const x = x0 + i * 44 + (i >= 3 ? 10 : 0);
      const bg = this.add.rectangle(x, 494, 40, 40, 0x1f2937).setOrigin(0).setStrokeStyle(1, COLORS.panelEdge).setDepth(1000).setInteractive({ useHandCursor: true });
      text(this, x + 20, 514, label, 20).setOrigin(0.5).setDepth(1001);
      bg.on('pointerover', () => this.hint.setText(tip));
      bg.on('pointerout', () => this.refreshHint());
      bg.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); fn(); });
    });
    this.compass = this.add.graphics().setDepth(1000);
    this.compassLabel = text(this, 0, 0, 'N', 10, '#ef4444').setOrigin(0.5).setDepth(1001);
    this.drawCompass();
  }

  /** Units first (their bodies stand above the terrain), then tiles front to back. */
  private pick(p: Vec): Point | null {
    const units = this.state.units.filter((u) => u.status !== 'lost').sort((a, b) => depthOf(this.iso, b.pos.x, b.pos.y) - depthOf(this.iso, a.pos.x, a.pos.y));
    for (const u of units) {
      const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
      const top = u.status === 'downed' ? c.y - 14 : c.y - 50;
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
    const i = this.hover ? valid.findIndex((p) => samePoint(p, this.hover!)) : -1;
    this.setHover(valid[(i + dir + valid.length) % valid.length]!);
  }

  private pressAction(i: number): void {
    const b = this.buttons[i];
    const u = activeUnit(this.state);
    if (!b || !u || u.team !== 'player' || (this.mode.kind !== 'move' && this.mode.kind !== 'target')) return;
    if (b.id === 'wait') {
      this.mode = { kind: 'facing', facing: u.facing };
    } else {
      if (this.state.acted || !abilityReady(u, b.id) || !targetTiles(this.state, u, b.id).length) return;
      this.mode = this.mode.kind === 'target' && this.mode.abilityId === b.id ? { kind: 'move' } : { kind: 'target', abilityId: b.id };
    }
    this.refresh();
  }

  private cancel(): void {
    if (this.mode.kind === 'target') this.mode = { kind: 'move' };
    else if (this.mode.kind === 'facing' && !this.state.acted) this.mode = { kind: 'move' };
    this.refresh();
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
      this.previewPanel.setText(this.previewText(preview).replace('\n\nClick to confirm', ''));
      await this.wait(700);
      await this.performAbility(u, plan.action.abilityId, plan.action.target);
      if (this.state.winner) return this.finish();
    }
    endTurn(this.state, plan.facing);
    await this.wait(250);
    this.nextTurn();
  }

  private async performAbility(u: Unit, abilityId: string, target: Point): Promise<void> {
    const results = useAbility(this.state, u.id, abilityId, target);
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
      v.root.setDepth(Math.max(depthOf(this.iso, p.x, p.y), depthOf(this.iso, prev.x, prev.y)) * 10 + 5);
      await new Promise<void>((r) => this.tweens.add({ targets: [v.root, v.outline], x: c.x, y: c.y, duration: 120, onComplete: () => r() }));
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
      if (line) this.log.push(line);
      this.react(e);
      if (e.type === 'ability') {
        console.info('[oathbound] action', JSON.stringify({
          turn: this.state.turnNumber, actor: e.unitId, ability: e.abilityId, target: e.target, from: e.preview.from,
          preview: e.preview.victims, results: e.results,
        }));
      }
    }
    this.log = this.log.slice(-14);
    this.logText.setText(this.log.join('\n'));
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
    const b = text(this, 640, 300, s, 40, color).setOrigin(0.5).setDepth(2500).setStroke('#000000', 6).setAlpha(0);
    this.tweens.add({ targets: b, alpha: 1, duration: 200, yoyo: true, hold: 900, onComplete: () => b.destroy() });
  }

  private react(e: BattleEvent): void {
    const isPlayer = (id: string) => this.state.units.find((u) => u.id === id)?.team === 'player';
    const reaction = (id: string, vow: string, kind: string) => {
      const line = lookup(`vows.${vow}.reaction.${id}.${kind}`);
      if (typeof line === 'string') this.say(id, line, 2400);
    };
    switch (e.type) {
      case 'ability':
        if (isPlayer(e.unitId)) this.barkFor(e.unitId, 'attack');
        for (const r of e.results) if (r.hit && r.damage > 0 && isPlayer(r.unitId) && getUnit(this.state, r.unitId).status === 'ok') this.barkFor(r.unitId, 'hit', false, 0.5);
        break;
      case 'downed':
        if (isPlayer(e.unitId)) this.barkFor(e.unitId, 'downed', true);
        else if (e.by && isPlayer(e.by)) this.barkFor(e.by, 'kill', true);
        break;
      case 'revived':
        if (isPlayer(e.unitId)) this.barkFor(e.unitId, 'revived', true);
        break;
      case 'vowProgress':
        if (e.vowId === 'bulwark' && e.progress >= e.goal) reaction(e.unitId, e.vowId, 'held');
        break;
      case 'vowFulfilled':
        // Bulwark is judged at battle end: its reaction belongs to the Reckoning.
        if (!this.state.winner) { reaction(e.unitId, e.vowId, 'kept'); this.banner(t('ui.banner.vowKept'), '#f5c451'); }
        break;
      case 'vowBroken':
        reaction(e.unitId, e.vowId, 'broken');
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
    this.logText.setVisible(!this.debug);
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
        if (sy > 66 && sy < 540 && sx >= 0 && sx <= 1280) return { x: sx, y: sy };
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
      get camera() { const c = scene.cameras.main; return { rot: scene.iso.rot ?? 0, zoom: c.zoom, scrollX: c.scrollX, scrollY: c.scrollY }; },
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
