import Phaser from 'phaser';
import { initVolume, preloadAudio } from '../audio';
import { preloadArt, setupArt } from '../art';
import { loadFonts } from '../fonts';

// Loads assets: Audio's music and sound effects, and Art's pixel-v1 sprite sheets.
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload(): void {
    preloadAudio(this);
    preloadArt(this);
  }

  create(): void {
    initVolume(this);
    setupArt(this);
    void loadFonts().then(() => this.scene.start('Menu'));
  }
}
