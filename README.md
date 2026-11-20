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
- `src/scenes/` Phaser scenes
- `public/assets/` art and audio, served as-is
- `.github/workflows/` CI (typecheck, test, build) and Pages deploy

## Playing the prototype battle (Mill Ford)
- **Move:** click a blue tile (or Tab through tiles and press Enter). Moving is optional and comes before acting.
- **Act:** pick an action (buttons or keys 1-6), hover a target to see hit %, exact damage and HP after, then click to confirm.
- **Wait / End turn:** `W`. Waiting without moving or acting brings your next turn sooner (the timeline shows where).
- **Facing:** after acting, click a gold tile or use the arrow keys, then Enter.
- `Esc` or right-click cancels. `D` toggles the debug overlay.
- Add `?seed=123` to the URL to replay a battle exactly.

## For QA
- Every action logs `[oathbound] action {...}` to the console with the preview and the actual result.
- `window.oathbound.state` is the live battle state; `window.oathbound.preview(actorId, abilityId, x, y)` returns a preview; `window.oathbound.plan(unitId)` returns what the AI would do; `window.oathbound.screenPointFor(x, y)` gives a clickable screen point for a tile.

## Code map
- `src/data/prototype-data.json` all rules, classes, abilities, vows, the map and units, owned by Game Design. Edit numbers here, not in code.
- `src/core/` rules engine, no Phaser: `battle.ts` (turn flow), `combat.ts` (hit, damage, previews), `pathfinding.ts`, `timeline.ts`, `ai.ts`.
- `src/render/iso.ts` isometric projection and tile picking.
- `src/scenes/` Phaser scenes: `BattleScene.ts` (gray-box battle UI), `ResultsScene.ts`.
- `tests/` Vitest unit tests for the engine.
