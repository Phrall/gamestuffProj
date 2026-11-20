import Phaser from 'phaser';

// Loads assets. Until Art delivers sprites, placeholder textures are generated here.
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create(): void {
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x6ee7b7).fillRect(0, 0, 32, 32);
    g.generateTexture('player', 32, 32);
    g.destroy();
    this.scene.start('Menu');
  }
}
