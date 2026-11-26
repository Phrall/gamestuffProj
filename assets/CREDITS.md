# Credits

Prototype art is from free packs, downloaded 2026-11-26. Each license was checked on the download page and in the pack's own license file.

| Asset pack | Used for | Source | Author | License |
|---|---|---|---|---|
| Tiny Tactics - Battle Kit I (v1.0) | Iso terrain (grass, dirt, water, bridge, pavement, heights, slopes, stairs), trees, rocks, logs, fences; Fighter, Mage and Cleric units and weapons, recoloured for all party and enemy units | https://tiopalada.itch.io/tiny-tactics-battle-kit-i | Gabriel "tiopalada" Lima | CC0 1.0 |
| Tiny RPG - Dragon Regalia GUI (v1.0) | 9-slice frames, buttons, bars, cursors (target cursor as vow sigil stand-in), portrait frame | https://tiopalada.itch.io/tiny-rpg-dragon-regalia-gui | Gabriel "tiopalada" Lima | CC0 1.0 |
| Isometric 64x64 Outside Tileset | Mill Ford terrain at 64x32 (B+C art): ground slabs, water, ford, bridge, boulders, pines, bushes, reeds, pebbles, log | https://opengameart.org/content/isometric-64x64-outside-tileset | Yar | CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/) |
| Pixel Bow Pack | Bows for the Bowhand and Court Archer | https://stealthix.itch.io/pixel-bow-pack | Stealthix | CC0 1.0 |

Notes
- **Required credit (CC BY 3.0)**, shown on the title screen next to the license link: Terrain tiles: "Isometric 64x64 Outside Tileset" by Yar (opengameart.org), CC BY 3.0. Modified: water recoloured, foam and edge pieces added. License: https://creativecommons.org/licenses/by/3.0/
- We don't use Yar's "Medieval Building" set.
- CC0 needs no attribution and no on-screen credit. We credit anyway, here and in the game's credits screen.
- tiopalada asks (outside the license) that the assets not be used to train AI models or in crypto projects. We honour this: the assets are used only in the game.
- Recoloured or edited versions are our own changes to CC0 art.


In the repo: `assets/art/bc/` holds Art's B+C atlases: `millford64` (Yar's tiles, recoloured and extended), `units48` (our own 48x64 units) and `sigils26` (our own vow sigils). `assets/art/tiny-tactics/` holds the files the game uses, copied and recoloured by `tools/art/build_tiny_tactics.py` (the Oathcourt pale grey and gold variants are our edits). `assets/art/pixel-v1/` is Art's own draft art, kept as a fallback. `assets/audio/` is original, made by `tools/audio/generate_audio.py`.

## Fonts

- **Tiny5** by Stefan Schmidt, SIL Open Font License 1.1 (via `@fontsource/tiny5`). Body and stat text at 8 px.
- **Pixelify Sans** by Stefie Justprince, SIL Open Font License 1.1 (via `@fontsource/pixelify-sans`). Headers and banners at 16 px.
- **OathGlyphs** (`assets/fonts/OathGlyphs.woff2`): our own 17 pixel symbols on Tiny5's grid, built by `tools/fonts/build_glyphs.py`.
