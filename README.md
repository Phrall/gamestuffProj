# Game prototype

Phaser 3 (HTML5/JavaScript), no build step.

## Run it
ES modules need a local web server (opening index.html directly won't work):

    cd gamestuffProj
    python -m http.server 8000

Then open http://localhost:8000.

## Layout
- `index.html` loads Phaser from a CDN and `src/main.js`
- `src/main.js` game config (960x540, arcade physics, auto-scaling)
- `src/scenes/BootScene.js` asset loading (placeholder textures for now)
- `src/scenes/MenuScene.js` title screen
- `src/scenes/GameScene.js` gameplay (placeholder movable square)
- `assets/` sprites, audio, etc. from the Art thread

## Next
Swap in real gameplay once the concept is chosen. If the project grows, move to Vite + npm for bundling and hot reload.
