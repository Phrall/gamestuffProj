import Phaser from 'phaser';
import { initVolume, preloadAudio } from '../audio';

// Loads assets: Audio's music and sound effects. Art's sprites come later.
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload(): void {
    preloadAudio(this);
  }

  create(): void {
    initVolume(this);
    this.scene.start('Menu');
  }
}
