import Phaser from 'phaser';
import { ABILITIES, CLASSES, millFordSetup } from '../data';
import { planTurn } from '../core/ai';
import { activeUnit, createBattle, endTurn, getUnit, moveUnit, startNextTurn, useAbility, type BattleState } from '../core/battle';
import { abilityReady, areaTiles, inRange, previewAction, targetTiles } from '../core/combat';
import { DIRS, FACINGS, facingToward, heightAt, key, samePoint, tileAt } from '../core/grid';
import { occupant, pathTo, pathTree, reachableTiles } from '../core/pathfinding';
import { effectiveStats, teamMorale } from '../core/stats';
import { forecast } from '../core/timeline';
import type { ActionPreview, BattleEvent, Facing, Point, Unit } from '../core/types';
import { pickTile, tileCenter, topDiamond, type IsoConfig, type Vec } from '../render/iso';
import { COLORS, FONT } from './theme';

type Mode =
  | { kind: 'busy' }
  | { kind: 'move' }
  | { kind: 'target'; abilityId: string }
  | { kind: 'facing'; facing: Facing };

interface UnitView {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  glyph: Phaser.GameObjects.Text;
  hp: Phaser.GameObjects.Graphics;
  nub: Phaser.GameObjects.Graphics;
}

const ENEMY_GLYPH: Record<string, string> = { captain: 'C', spearA: 'P', spearB: 'P', archerA: 'A', archerB: 'A', binder: 'O' };
const ISO_DIR: Record<Facing, Vec> = { E: { x: 1, y: 0.5 }, S: { x: -1, y: 0.5 }, N: { x: 1, y: -0.5 }, W: { x: -1, y: -0.5 } };

export const abilityLabel = (id: string): string => id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

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
    this.state = createBattle(millFordSetup(), seed);
    this.views.clear();
    this.overlays = [];
    this.buttons = [];
    this.log = [];
    this.eventCursor = 0;
    this.mode = { kind: 'busy' };

    this.drawMap();
    for (const u of this.state.units) this.views.set(u.id, this.makeUnitView(u));
    this.drawUi();
    this.bindInput();
    this.exposeForQa();
    console.info('[oathbound] battle start', JSON.stringify({ seed, map: this.state.map.id }));
    this.nextTurn();
  }

  // ---------- map and units ----------

  private drawMap(): void {
    const { map } = this.state;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const t = tileAt(map, { x, y })!;
        const g = this.add.graphics().setDepth((x + y) * 10);
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
        this.overlays.push(this.add.graphics().setDepth((x + y) * 10 + 1));
      }
    }
  }

  private makeUnitView(u: Unit): UnitView {
    const root = this.add.container(0, 0);
    const body = this.add.graphics();
    const nub = this.add.graphics();
    const glyph = text(this, 0, -22, u.classId ? CLASSES[u.classId]!.name[0]! : ENEMY_GLYPH[u.id] ?? u.name[0]!, 16, '#111318').setOrigin(0.5);
    const hp = this.add.graphics();
    root.add([nub, body, glyph, hp]);
    const view = { root, body, glyph, hp, nub };
    this.placeUnit(u, u.pos, view);
    return view;
  }

  private placeUnit(u: Unit, p: Point, view = this.views.get(u.id)): void {
    if (!view) return;
    const c = tileCenter(this.iso, p.x, p.y, heightAt(this.state.map, p));
    view.root.setPosition(c.x, c.y).setDepth((p.x + p.y) * 10 + 5);
  }

  private drawUnit(u: Unit): void {
    const v = this.views.get(u.id);
    if (!v) return;
    v.root.setVisible(u.status !== 'lost');
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
      v.glyph.setY(-20).setText(u.classId ? CLASSES[u.classId]!.name[0]! : ENEMY_GLYPH[u.id] ?? u.name[0]!);
    }
    v.nub.clear();
    if (u.status === 'ok') {
      const d = ISO_DIR[u.facing];
      v.nub.fillStyle(0xffffff, 0.9).fillTriangle(d.x * 22, d.y * 22, d.x * 10 - d.y * 8, d.y * 10 + d.x * 4, d.x * 10 + d.y * 8, d.y * 10 - d.x * 4);
    }
    v.hp.clear();
    if (u.status !== 'ok') return;
    const frac = Math.max(0, u.hp / u.base.hp);
    v.hp.fillStyle(0x000000, 0.7).fillRect(-15, -46, 30, 5);
    v.hp.fillStyle(frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfacc15 : 0xef4444).fillRect(-15, -46, 30 * frac, 5);
  }

  // ---------- UI ----------

  private drawUi(): void {
    this.timeline = this.add.container(0, 0).setDepth(1000);
    this.moraleText = text(this, 1270, 12, '', 14).setOrigin(1, 0).setDepth(1000);
    this.logText = text(this, 12, 96, '', 12, COLORS.textDim).setDepth(1000).setWordWrapWidth(280);
    this.debugText = text(this, 1268, 96, '', 11, '#a7f3d0').setOrigin(1, 0).setDepth(1001).setBackgroundColor('#000000cc').setVisible(false);

    const panel = (x: number, w: number) => this.add.rectangle(x, 548, w, 162, COLORS.panel).setOrigin(0).setStrokeStyle(1, COLORS.panelEdge).setDepth(999);
    panel(10, 380);
    panel(400, 480);
    panel(890, 380);
    this.unitPanel = text(this, 22, 558, '', 14).setDepth(1000).setLineSpacing(4);
    this.previewPanel = text(this, 902, 558, '', 14).setDepth(1000).setLineSpacing(4).setWordWrapWidth(360);
    this.hint = text(this, 640, 528, '', 14, COLORS.textDim).setOrigin(0.5).setDepth(1000);
    text(this, 12, 700, 'D: debug   Esc/right-click: cancel   1-6: actions   Tab/Enter: pick tile   W: wait', 11, '#6b7280').setOrigin(0, 1).setDepth(1000);
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
      b.label.setText(`${i + 1} ${b.id === 'wait' ? (this.state.moved || this.state.acted ? 'End turn' : 'Wait') : abilityLabel(b.id)}${suffix}`);
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
    text(this, x0 - 12, 30, 'NEXT', 12, COLORS.textDim).setOrigin(1, 0.5).setDepth(1000);
    entries.forEach((e, i) => {
      const u = getUnit(this.state, e.unitId);
      const x = x0 + i * (w + 6);
      const lit = this.hoverUnitId === u.id;
      const bg = this.add.rectangle(x, 12, w, 36, u.team === 'player' ? 0x0c4a6e : 0x7f1d1d).setOrigin(0)
        .setStrokeStyle(i === 0 || lit ? 2 : 1, i === 0 ? COLORS.gold : lit ? COLORS.hover : COLORS.panelEdge)
        .setInteractive();
      bg.on('pointerover', () => { this.hoverUnitId = u.id; this.refreshUnits(); this.refreshTimeline(); });
      bg.on('pointerout', () => { this.hoverUnitId = null; this.refreshUnits(); this.refreshTimeline(); });
      const t = text(this, x + w / 2, 30, `${e.downed ? '☠ ' : ''}${u.name.replace('Court ', '')}`, 12).setOrigin(0.5);
      this.timeline.add([bg, t]);
    });
    // Wait ghost (UX board): where the active unit would land if it waited (CT 40).
    const a = activeUnit(this.state);
    if (a && a.team === 'player' && !this.state.moved && !this.state.acted) {
      const ghost = forecast(this.state.units, 8, a.id, 40).findIndex((e, i) => i > 0 && e.unitId === a.id);
      if (ghost > 0) {
        const gx = x0 + ghost * (w + 6) + w / 2;
        this.timeline.add(text(this, gx, 54, '▲ if Wait', 11, '#f5c451').setOrigin(0.5, 0));
      }
    }
  }

  private refreshMorale(): void {
    const p = this.state.morale.player;
    const e = this.state.morale.enemy;
    this.moraleText.setText(`Squad morale ${p} ${teamMorale(this.state, 'player').name}\nFoe morale   ${e} ${teamMorale(this.state, 'enemy').name}`);
  }

  private unitSummary(u: Unit, title: string): string {
    const s = effectiveStats(this.state, u);
    const moraleMove = u.moraleMove ? ` (${u.moraleMove} Shaken)` : '';
    const mods = u.modifiers.map((m) => abilityLabel(m.source)).join(', ');
    const cls = u.classId ? CLASSES[u.classId]!.name : u.leader ? 'Leader' : 'Oathcourt';
    return [
      `${title}${u.name}  ·  ${cls}${u.status !== 'ok' ? `  ·  ${u.status.toUpperCase()} (${u.reviveCounter})` : ''}`,
      `HP ${u.hp}/${u.base.hp}   CT ${u.ct}   Facing ${u.facing}`,
      `Atk ${s.atk}  Mag ${s.mag}  Def ${s.def}  Res ${s.res}`,
      `Spd ${s.spd}  Move ${s.move}${moraleMove}  Jump ${s.jump}  Eva ${s.eva}`,
      mods ? `Effects: ${mods}` : '',
    ].filter(Boolean).join('\n');
  }

  private refreshPanels(preview: ActionPreview | null): void {
    const a = activeUnit(this.state);
    this.unitPanel.setText(a ? this.unitSummary(a, a.team === 'player' ? '▶ ' : 'Enemy turn: ') : '');
    if (preview) {
      this.previewPanel.setText(this.previewText(preview));
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
    for (const v of p.victims) {
      const u = getUnit(this.state, v.unitId);
      const tags = [v.side !== 'front' ? v.side.toUpperCase() : 'front', v.heightDiff ? `height ${v.heightDiff > 0 ? '+' : ''}${v.heightDiff}` : ''].filter(Boolean).join(' · ');
      if (v.heal || v.revives) {
        lines.push(`${u.name}: ${v.revives ? 'REVIVE, ' : ''}heal ${v.heal}  HP ${u.hp} → ${v.hpAfter}`);
      } else if (v.damage) {
        lines.push(`${u.name}${u.team === getUnit(this.state, p.actorId).team ? ' (ally!)' : ''}`);
        lines.push(`  Hit ${v.hit}%   Dmg ${v.damage}   HP ${u.hp} → ${v.hpAfter}${v.downs ? '  DOWNS' : ''}`);
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
    const u = activeUnit(this.state);
    let preview: ActionPreview | null = null;
    const paint = (p: Point, color: number, alpha: number, stroke = false) => {
      const g = this.overlays[p.y * this.state.map.width + p.x];
      if (!g) return;
      const d = topDiamond(this.iso, p.x, p.y, heightAt(this.state.map, p));
      if (stroke) g.lineStyle(2, color, alpha).strokePoints(d, true);
      else g.fillStyle(color, alpha).fillPoints(d, true);
    };
    if (u && u.team === 'player') {
      if (this.mode.kind === 'move' && !this.state.moved) {
        const tree = pathTree(this.state, u);
        for (const n of reachableTiles(this.state, u)) paint(n.pos, COLORS.move, 0.35);
        if (this.hover && tree.has(key(this.hover)) && !occupant(this.state, this.hover)) {
          for (const p of pathTo(tree, this.hover)) paint(p, COLORS.move, 0.55);
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
    this.refreshPanels(preview);
    this.refreshButtons();
    this.refreshTimeline();
    this.refreshMorale();
    this.refreshHint();
    this.flushEvents();
    if (this.debug) this.debugText.setText(this.debugDump(preview));
  }

  private refreshHint(): void {
    const u = activeUnit(this.state);
    let h = '';
    if (!u) h = '';
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
      const t = this.pick({ x: p.worldX, y: p.worldY });
      if (t?.x === this.hover?.x && t?.y === this.hover?.y) return;
      this.setHover(t);
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) this.cancel();
      else if (this.hover) void this.clickTile(this.hover);
    });
    const kb = this.input.keyboard!;
    kb.on('keydown', (e: KeyboardEvent) => {
      if (e.key >= '1' && e.key <= '9') this.pressAction(Number(e.key) - 1);
      else if (e.key === 'w' || e.key === 'W') this.pressAction(this.buttons.findIndex((b) => b.id === 'wait'));
      else if (e.key === 'Escape') this.cancel();
      else if (e.key === 'd' || e.key === 'D') this.toggleDebug();
      else if (e.key === 'Tab') { e.preventDefault(); this.cycleTarget(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Enter' && (this.mode.kind === 'target' || this.mode.kind === 'move') && this.hover) void this.clickTile(this.hover);
      else if (this.mode.kind === 'facing') {
        const map: Record<string, Facing> = { ArrowUp: 'N', ArrowRight: 'E', ArrowDown: 'S', ArrowLeft: 'W' };
        const f = map[e.key];
        const u = activeUnit(this.state);
        if (f && u) { this.mode = { kind: 'facing', facing: f }; u.facing = f; this.refresh(); }
        if (e.key === 'Enter') this.confirmFacing();
      }
    });
  }

  /** Units first (their bodies stand above the terrain), then tiles front to back. */
  private pick(p: Vec): Point | null {
    const units = this.state.units.filter((u) => u.status !== 'lost').sort((a, b) => b.pos.x + b.pos.y - (a.pos.x + a.pos.y));
    for (const u of units) {
      const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
      if (Math.abs(p.x - c.x) <= 14 && p.y >= c.y - 48 && p.y <= c.y - 2) return { ...u.pos };
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
      v.root.setDepth(Math.max(p.x + p.y, prev.x + prev.y) * 10 + 5);
      await new Promise<void>((r) => this.tweens.add({ targets: v.root, x: c.x, y: c.y, duration: 120, onComplete: () => r() }));
      prev = p;
    }
    this.placeUnit(u, u.pos);
    this.refresh();
  }

  private floatText(u: Unit, s: string, color: string): void {
    const c = tileCenter(this.iso, u.pos.x, u.pos.y, heightAt(this.state.map, u.pos));
    const t = text(this, c.x, c.y - 60, s, 20, color).setOrigin(0.5).setDepth(2000).setStroke('#000000', 4);
    this.tweens.add({ targets: t, y: t.y - 30, alpha: 0, duration: 1100, delay: 200, onComplete: () => t.destroy() });
  }

  // ---------- log, debug and QA hooks ----------

  private flushEvents(): void {
    const events = this.state.events;
    for (; this.eventCursor < events.length; this.eventCursor++) {
      const e = events[this.eventCursor]!;
      const line = this.describe(e);
      if (line) this.log.push(line);
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
      case 'morale': return `${e.team === 'player' ? 'Squad' : 'Foe'} morale ${e.delta > 0 ? '+' : ''}${e.delta} (${e.reason})`;
      case 'battleEnd': return e.winner === 'player' ? 'Victory!' : 'Defeat…';
      default: return '';
    }
  }

  private toggleDebug(): void {
    this.debug = !this.debug;
    this.debugText.setVisible(this.debug);
    this.refresh();
  }

  private debugDump(preview: ActionPreview | null): string {
    const s = this.state;
    const rows = s.units.map((u) => {
      const st = effectiveStats(s, u);
      const cds = Object.entries(u.cooldowns).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
      return `${u.id.padEnd(8)} ${u.status.padEnd(6)} hp ${String(u.hp).padStart(2)}/${u.base.hp} ct ${String(u.ct).padStart(3)} (${u.pos.x},${u.pos.y},h${heightAt(s.map, u.pos)}) ${u.facing} a${st.atk} d${st.def} r${st.res} mv${st.move} ${cds}`;
    });
    const pv = preview ? `\npreview ${JSON.stringify(preview.victims.map((v) => ({ id: v.unitId, hit: v.hit, dmg: v.damage, side: v.side, dh: v.heightDiff })))}` : '';
    return [`seed ${s.seed}  turn ${s.turnNumber}  morale P${s.morale.player} E${s.morale.enemy}`, ...rows].join('\n') + pv;
  }

  private screenPointFor(t: Point): Vec | null {
    const c = tileCenter(this.iso, t.x, t.y, heightAt(this.state.map, t));
    for (let dy = -46; dy <= 14; dy += 2) {
      for (let dx = -28; dx <= 28; dx += 4) {
        const p = { x: c.x + dx, y: c.y + dy };
        const hit = this.pick(p);
        if (hit && samePoint(hit, t)) return p;
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
      /** What the enemy AI would do with this unit; QA uses it for automated runs. */
      plan: (unitId: string) => planTurn(this.state, getUnit(this.state, unitId)),
    };
  }
}

function describeEffect(abilityId: string): string {
  const a = ABILITIES[abilityId];
  if (!a) return '';
  if (a.buff) return [a.buff.def ? `+${a.buff.def} Def` : '', a.buff.res ? `+${a.buff.res} Res` : '', a.buff.allFront ? 'all hits count as front' : ''].filter(Boolean).join(', ');
  if (a.morale) return `+${a.morale} squad morale`;
  return abilityLabel(abilityId);
}
