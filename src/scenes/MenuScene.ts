import Phaser from 'phaser';
import { FONT } from './theme';
import { fitScene, layoutSize } from '../view';
import { playMusic, sfx, toggleMute, volumeLabel } from '../audio';

export default class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create(): void {
    fitScene(this);
    const { w: width, h: height } = layoutSize();
    this.add.text(width / 2, height / 2 - 60, 'OATHBOUND', { fontFamily: FONT, fontSize: '56px', color: '#f5c451' }).setOrigin(0.5);
    this.add.text(width / 2, height / 2, 'Prototype: Mill Ford', { fontFamily: FONT, fontSize: '22px', color: '#e5e7eb' }).setOrigin(0.5);
    this.add.text(width / 2, height / 2 + 60, 'Click or press SPACE to start', { fontFamily: FONT, fontSize: '18px', color: '#9ca3af' }).setOrigin(0.5);

    const vol = this.add.text(width / 2, height / 2 + 96, `M: sound ${volumeLabel()}`, { fontFamily: FONT, fontSize: '14px', color: '#6b7280' }).setOrigin(0.5);
    this.input.keyboard?.on('keydown-M', () => { toggleMute(this); vol.setText(`M: sound ${volumeLabel()}`); });
    // CC-BY 3.0 needs the credit on screen with the license link (Art, assets/CREDITS.md).
    this.add.text(width / 2, height - 30, 'Terrain tiles: "Isometric 64x64 Outside Tileset" by Yar (opengameart.org), CC BY 3.0. Modified: water recoloured, foam and edge pieces added.', { fontFamily: FONT, fontSize: '11px', color: '#9ca3af', align: 'center', wordWrap: { width: width - 32 } }).setOrigin(0.5, 1);
    this.add.text(width / 2, height - 14, 'https://creativecommons.org/licenses/by/3.0/', { fontFamily: FONT, fontSize: '11px', color: '#9ca3af' }).setOrigin(0.5, 1);
    // Browsers keep audio locked until the first click or key; Phaser unlocks on it and the music starts then.
    playMusic(this, 'mus_camp_loop');
    const start = () => { sfx(this, 'ui_click'); this.scene.start('Battle'); };
    this.input.keyboard?.once('keydown-SPACE', start);
    this.input.once('pointerdown', start);
  }
}
