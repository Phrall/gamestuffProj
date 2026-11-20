# Oathbound

A browser tactics RPG where units grow into new classes by keeping the vows they swear before each battle.

Built with Phaser 3, TypeScript and Vite.

## Play
Once Pages is enabled, every merge to `main` is published to
https://phrall.github.io/gamestuffProj/

## Run locally
Requires [Node.js](https://nodejs.org/) 20.19 or newer.

    git clone https://github.com/Phrall/gamestuffProj.git
    cd gamestuffProj
    npm install
    npm run dev

The game opens at http://localhost:5173 and reloads as you edit.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Production build into `dist/` |

## Layout
- `src/main.ts` game config and scene list
- `src/scenes/` Phaser scenes (boot, menu, game)
- `public/assets/` art and audio, served as-is
- `.github/workflows/` CI (typecheck, test, build) and Pages deploy
