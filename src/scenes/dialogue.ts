import Phaser from 'phaser';
import { guiPanel } from '../art';
import { t, unitName } from '../data/strings';
import { COLORS, FONT } from './theme';

export interface Line { id: string; speaker: string; text: string }

/**
 * Show scene lines one at a time in a box over the bottom panels (HUD depth).
 * Click, Space or Enter advances; Esc skips the rest. Calls `done` once at the end.
 */
export function playDialogue(scene: Phaser.Scene, lines: Line[], done: () => void, y = 548): void {
  if (!lines.length) { done(); return; }
  const box = scene.add.rectangle(10, y, 1260, 162, COLORS.panel, 0.97).setOrigin(0).setStrokeStyle(2, COLORS.gold).setDepth(3100).setInteractive();
  // Dragon Regalia frame on top when the GUI art can draw; the solid box under it hides the HUD panels.
  const frame = guiPanel(scene, 10, y, 1260, 162)?.setDepth(3100.5) ?? null;
  if (frame) box.setStrokeStyle();
  const who = scene.add.text(30, y + 14, '', { fontFamily: FONT, fontSize: '16px', color: '#f5c451' }).setDepth(3101);
  const body = scene.add.text(30, y + 42, '', { fontFamily: FONT, fontSize: '18px', color: COLORS.text, wordWrap: { width: 1200 }, lineSpacing: 6 }).setDepth(3101);
  const help = scene.add.text(1250, y + 140, 'Click / Space: next   Esc: skip', { fontFamily: FONT, fontSize: '11px', color: COLORS.textDim }).setOrigin(1, 0.5).setDepth(3101);
  let i = 0;
  let finished = false;
  const show = () => {
    const l = lines[i]!;
    const name = l.speaker === 'narrator' ? '' : (t(`speakers.${l.speaker}`) || unitName(l.speaker));
    who.setText(name);
    body.setText(l.text).setColor(l.speaker === 'narrator' ? COLORS.textDim : COLORS.text);
    console.info('[oathbound] line', l.id);
  };
  const end = () => {
    if (finished) return;
    finished = true;
    scene.input.keyboard?.off('keydown', onKey);
    for (const o of [box, who, body, help, frame]) o?.destroy();
    done();
  };
  const next = () => { if (finished) return; i += 1; if (i >= lines.length) end(); else show(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') end();
    else if (e.key === ' ' || e.key === 'Enter') next();
  };
  box.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => { ev.stopPropagation(); next(); });
  scene.input.keyboard?.on('keydown', onKey);
  show();
}
