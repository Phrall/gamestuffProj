import Phaser from 'phaser';

// Placeholder scene: a square you can move with arrows/WASD.
// Replaced by the battle scene in the engine work.
const SPEED = 220;

type Keys = Record<'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'W' | 'A' | 'S' | 'D' | 'ESC', Phaser.Input.Keyboard.Key>;

export default class GameScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Image;
  private keys!: Keys;

  constructor() { super('Game'); }

  create(): void {
    const { width, height } = this.scale;
    this.player = this.add.image(width / 2, height / 2, 'player');
    this.keys = this.input.keyboard!.addKeys('UP,DOWN,LEFT,RIGHT,W,A,S,D,ESC') as Keys;
    this.add.text(12, 12, 'Arrows/WASD to move, ESC for menu', {
      fontFamily: 'monospace', fontSize: '14px', color: '#9ca3af',
    });
  }

  update(_time: number, delta: number): void {
    const k = this.keys;
    const x = Number(k.RIGHT.isDown || k.D.isDown) - Number(k.LEFT.isDown || k.A.isDown);
    const y = Number(k.DOWN.isDown || k.S.isDown) - Number(k.UP.isDown || k.W.isDown);
    const v = new Phaser.Math.Vector2(x, y).normalize().scale((SPEED * delta) / 1000);
    const { width, height } = this.scale;
    this.player.x = Phaser.Math.Clamp(this.player.x + v.x, 16, width - 16);
    this.player.y = Phaser.Math.Clamp(this.player.y + v.y, 16, height - 16);
    if (Phaser.Input.Keyboard.JustDown(k.ESC)) this.scene.start('Menu');
  }
}
