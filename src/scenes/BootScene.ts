import Phaser from 'phaser';

// Loads assets. The prototype is gray-box, so nothing to load yet; Art's sprites come later.
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create(): void {
    this.scene.start('Menu');
  }
}
