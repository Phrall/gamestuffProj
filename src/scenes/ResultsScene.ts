import Phaser from 'phaser';
import type { BattleState } from '../core/battle';
import { FONT } from './theme';

// Minimal end screen. The full Reckoning (vow results, Resolve, Shadow) is issue #10.
export default class ResultsScene extends Phaser.Scene {
  constructor() { super('Results'); }

  create(data: { state: BattleState }): void {
    const s = data.state;
    const { width } = this.scale;
    const won = s.winner === 'player';
    this.add.text(width / 2, 90, won ? 'VICTORY' : 'DEFEAT', { fontFamily: FONT, fontSize: '56px', color: won ? '#f5c451' : '#f87171' }).setOrigin(0.5);
    this.add.text(width / 2, 150, `Mill Ford · ${s.turnNumber} turns · seed ${s.seed}`, { fontFamily: FONT, fontSize: '16px', color: '#9ca3af' }).setOrigin(0.5);

    const rows = s.units.filter((u) => u.team === 'player').map((u) =>
      `${u.name.padEnd(8)} ${u.status.padEnd(7)} HP ${String(u.hp).padStart(2)}/${u.base.hp}   defeats ${u.defeats}   XP ${u.xp}`);
    rows.push('', `Squad morale ${s.morale.player}`);
    this.add.text(width / 2, 300, rows.join('\n'), { fontFamily: FONT, fontSize: '20px', color: '#e5e7eb', lineSpacing: 10 }).setOrigin(0.5);

    this.add.text(width / 2, 560, 'Click or press SPACE to fight again', { fontFamily: FONT, fontSize: '18px', color: '#9ca3af' }).setOrigin(0.5);
    const again = () => this.scene.start('Battle');
    this.input.keyboard?.once('keydown-SPACE', again);
    this.time.delayedCall(400, () => this.input.once('pointerdown', again));
  }
}
