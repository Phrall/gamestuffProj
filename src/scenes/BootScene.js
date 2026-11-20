// Loads assets. Until Art delivers sprites, placeholder textures are generated here.
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload() {
    // this.load.image('player', 'assets/player.png');  // swap in real art later
  }

  create() {
    const g = this.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0x6ee7b7).fillRect(0, 0, 32, 32);
    g.generateTexture('player', 32, 32);
    g.destroy();
    this.scene.start('Menu');
  }
}
