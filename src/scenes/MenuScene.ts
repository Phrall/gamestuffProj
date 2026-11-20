import Phaser from 'phaser';
import { FONT } from './theme';

export default class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create(): void {
    const { width, height } = this.scale;
    this.add.text(width / 2, height / 2 - 60, 'OATHBOUND', { fontFamily: FONT, fontSize: '56px', color: '#f5c451' }).setOrigin(0.5);
    this.add.text(width / 2, height / 2, 'Prototype: Mill Ford', { fontFamily: FONT, fontSize: '22px', color: '#e5e7eb' }).setOrigin(0.5);
    this.add.text(width / 2, height / 2 + 60, 'Click or press SPACE to start', { fontFamily: FONT, fontSize: '18px', color: '#9ca3af' }).setOrigin(0.5);

    const start = () => this.scene.start('Battle');
    this.input.keyboard?.once('keydown-SPACE', start);
    this.input.once('pointerdown', start);
  }
}
