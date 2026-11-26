# Oathbound pixel art, draft v1 (placeholders)

Pixel art, chosen by Jen on 2026-11-20. Render at 2x in Phaser with `pixelArt: true`.
These are first-pass placeholders so Programming can replace the gray-box. Expect redraws.

## Sheets (PNG + Phaser JSON-hash atlas)
- `tiles.png/.json`: 32x48 frames, bottom-aligned.
  - `grass_h{0-3}_v{0-2}`: grass tile at height 0-3, 3 variants.
  - `water_f{0-3}`: stream water, 4-frame loop (surface sits 3 px below height 0).
  - `ford_f{0-1}`: ford with stepping stones, 2-frame loop.
- `props.png/.json`: 32x32 frames.
  - `boulder_v{0-1}`: draw on top of a height-0 grass tile, top-left at (tileX, tileTopY - 16).
  - `overlay_move|attack|area|selected`: 32x16 grid highlights (draw at the tile top).
- `units.png/.json`: 32x32 cells, feet at the bottom centre. Facing down-right, idle frame 0 only.
  - `unit_sellsword|spearman|archer|captain|binder_se_idle0`. Bowhand and Hedge Mage are not drawn yet.
- `sigils.png/.json`: 13x13 `sigil_intact`, `sigil_broken`.

## Placing tiles
Isometric step: x+1 moves (+16, +8) px, y+1 moves (-16, +8) px.
For tile (x, y) with top-left of its height-0 diamond at (sx, sy):
- tile frame: draw with origin (0, 0) at (sx, sy + 22 - 48) = (sx, sy - 26). Frames are bottom-aligned, so every height lines up.
- tile top at height h: sy - 8*h. Units: draw the 32x32 cell at (sx, top - 23).
- Draw in order of x + y ascending (back to front).

## Highlight colours (agreed with UX/UI)
- Selected tile, active unit, deploy zone: bone #EDE6D3
- Move range: pale blue #9FC3D6
- Attack range and target: red-orange #C0533F
- Area of effect: light red-orange #E0876A
Gold (#E3B54A) is only for oath magic; violet (#6E5AA8) is only for shadow.

Preview of the Mill Ford map: `millford-preview-2x.png`.

## Update 2026-11-21: rotation, death and downed
- Camera rotation (90° steps): tile art is lit from the screen, so tiles need no per-rotation art. The one exception is the stream:
  use `water_f*` / `ford_f*` when the stream runs along screen down-right, and `water_y_f*` / `ford_y_f*` when it runs down-left
  (after rotating 90° or 270°), so ripples and ford stones follow the flow. Re-sort draw order by the rotated x + y.
- Unit facing: compute the facing in screen space after rotation, then pick the frame:
  down-right = `*_se_*`, down-left = `*_se_*` flipped, up-right = `*_ne_*`, up-left = `*_ne_*` flipped.
  New back-facing frames: `unit_<kind>_ne_idle0`.
- Hidden units: a unit standing behind a taller tile can be covered after rotation. Please draw an outline-only silhouette
  of the unit (bone #EDE6D3, ~60% alpha) over terrain when it is occluded.
- Death: `unit_<kind>_se_death0..5` (recoil, buckle, tip, on the ground, dust x2). Play at ~10 fps, then tween alpha 1 → 0 over
  about 400 ms on frames 4-5 and remove the unit. Mirror for other facings.
- Downed ally: `unit_<kind>_downed` (lying, desaturated) on top of `overlay_downed` (dashed bone outline with a faint fill), with
  `revive_3|2|1` pips (in sigils.png) above it. The dashed outline is the "you can walk through" signal.
- See `rotation-check-2x.png` (all four rotations) and `death-and-downed-4x.png`.
