import Phaser from 'phaser';
import BootScene from './scenes/BootScene';
import MenuScene from './scenes/MenuScene';
import BattleScene from './scenes/BattleScene';
import ResultsScene from './scenes/ResultsScene';
import { canvasSize, cssZoom, installCrispText, watchScale } from './view';

installCrispText();

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  ...canvasSize(),
  backgroundColor: '#1d1f27',
  pixelArt: true,
  // Whole-number scaling only (src/view.ts): the canvas is sized in device pixels, never stretched.
  scale: { mode: Phaser.Scale.NONE, zoom: cssZoom(), autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [BootScene, MenuScene, BattleScene, ResultsScene],
};

// Exposed for debugging and automated smoke tests.
const game = new Phaser.Game(config);
watchScale(game);
(window as unknown as { game: Phaser.Game }).game = game;
