// Placeholder gameplay: a square you can move with arrows/WASD.
// Real mechanics go here once the Director picks the concept.
const SPEED = 220;

export default class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  create() {
    const { width, height } = this.scale;
    this.player = this.physics.add.sprite(width / 2, height / 2, 'player');
    this.player.setCollideWorldBounds(true);

    this.keys = this.input.keyboard.addKeys('UP,DOWN,LEFT,RIGHT,W,A,S,D,ESC');
    this.add.text(12, 12, 'Arrows/WASD to move, ESC for menu', {
      fontFamily: 'monospace', fontSize: '14px', color: '#9ca3af',
    });
  }

  update() {
    const k = this.keys;
    const x = (k.RIGHT.isDown || k.D.isDown) - (k.LEFT.isDown || k.A.isDown);
    const y = (k.DOWN.isDown || k.S.isDown) - (k.UP.isDown || k.W.isDown);
    const v = new Phaser.Math.Vector2(x, y).normalize().scale(SPEED);
    this.player.setVelocity(v.x, v.y);

    if (Phaser.Input.Keyboard.JustDown(k.ESC)) this.scene.start('Menu');
  }
}
