import Phaser from 'phaser';

export default class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create(): void {
    const { width, height } = this.scale;
    this.add.text(width / 2, height / 2 - 30, 'OATHBOUND', {
      fontFamily: 'monospace', fontSize: '40px', color: '#ffffff',
    }).setOrigin(0.5);
    this.add.text(width / 2, height / 2 + 30, 'Press SPACE or click to start', {
      fontFamily: 'monospace', fontSize: '18px', color: '#9ca3af',
    }).setOrigin(0.5);

    const start = () => this.scene.start('Game');
    this.input.keyboard?.once('keydown-SPACE', start);
    this.input.once('pointerdown', start);
  }
}
