"""Copy the Tiny Tactics / Pixel Bow Pack files the game uses into assets/art/tiny-tactics/
and make the Oathcourt recolours (pale grey and gold), per Art's mapping in
/mnt/project-files/oathbound/art/packs/README.md.

Usage: python3 -I tools/art/build_tiny_tactics.py <packs dir> <out dir>
"""
import glob
import os
from collections import Counter
import shutil
import sys

from PIL import Image

packs, out = sys.argv[1], sys.argv[2]
tt = os.path.join(packs, 'tiny-tactics')
os.makedirs(out, exist_ok=True)


def src(name):
    hits = glob.glob(os.path.join(tt, '*' + name))
    assert len(hits) == 1, name
    return hits[0]


def is_hair(r, g, b):
    """The pack's pink/magenta hair ramp."""
    import colorsys
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return 0.85 <= h <= 0.99 and s > 0.4 and l > 0.25, l


def hair_shade(ramp, l):
    return ramp[0 if l < 0.42 else 1 if l < 0.58 else 2]


SQUAD_HAIR = [(0x5A, 0x3A, 0x2E), (0x7E, 0x50, 0x38), (0xA8, 0x74, 0x4E)]  # chestnut
COURT_HAIR = [(0x5E, 0x58, 0x4F), (0x7A, 0x73, 0x68), (0xA9, 0xAD, 0xA6)]  # cool grey (Art)


def oathcourt(im):
    """Pale grey with gold trim: keep the dark outline, map light to pale grey,
    hair to a cool grey ramp, and the pack's other saturated bright pixels (trim) gold."""
    im = im.convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hair, l = is_hair(r, g, b)
            if hair:
                px[x, y] = (*hair_shade(COURT_HAIR, l), a)
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            sat = max(r, g, b) - min(r, g, b)
            if lum < 72:  # outline
                px[x, y] = (38, 32, 40, a)
            elif sat > 120 and lum > 110:  # bright saturated -> gold
                k = min(1.0, (lum - 110) / 120)
                px[x, y] = (int(176 + 51 * k), int(128 + 53 * k), int(48 + 26 * k), a)
            else:
                t = min(1.0, (lum - 72) / 150)
                px[x, y] = (int(118 + 124 * t), int(114 + 122 * t), int(110 + 116 * t), a)
    return im


def chestnut_hair(im):
    """Squad hair: the pack's pink/magenta ramp becomes chestnut (Art), so it can't read as the crimson enemy cue."""
    im = im.convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hair, l = is_hair(r, g, b)
            if hair:
                px[x, y] = (*hair_shade(SQUAD_HAIR, l), a)
    return im


for body in ('fighter', 'mage', 'cleric'):
    for face in ('NE', 'SE'):
        for kind in ('walking', 'attack', 'dead', 'weak', 'damage', 'release'):
            name = f'{body}-{kind}{face}.png'
            chestnut_hair(Image.open(src(name))).save(os.path.join(out, name))
            if body in ('fighter', 'cleric'):
                oathcourt(Image.open(src(name))).save(os.path.join(out, f'{body}_oc-{kind}{face}.png'))

for weapon in ('IronSword', 'IronAxe', 'WoodenStaff', 'Scepter'):
    for face in ('NE', 'SE'):
        shutil.copy(src(f'weapons-{weapon}attack{face}.png'), os.path.join(out, f'weapon-{weapon}{face}.png'))

shutil.copy(src('tinyTacticsTileset00.png'), os.path.join(out, 'tileset.png'))
# Bow: Art asked for the No Outline set; Bow1 is plain wood.
shutil.copy(os.path.join(packs, 'pixel-bow-pack', 'Single Files', 'No Outline', 'Bow1.png'), os.path.join(out, 'bow.png'))

# ---------- Dragon Regalia GUI (Art: frames, buttons) ----------
# The pack's fills are bright; the battle HUD is dark, so we keep the gold frames and swap the fills.
gui = os.path.join(packs, 'dragon-regalia-gui')


def gui_src(name):
    hits = glob.glob(os.path.join(gui, '*' + name))
    assert len(hits) == 1, name
    return Image.open(hits[0]).convert('RGBA')


def refill(im, swaps):
    im = im.copy()
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a and (r, g, b) in swaps:
                px[x, y] = (*swaps[(r, g, b)], a)
    return im


PANEL_FILL = (22, 24, 34)       # near COLORS.panel, a touch of the pack's navy
PANEL_SHADE = (34, 34, 58)
refill(gui_src('dragon9SlicesB.png'), {(67, 147, 214): PANEL_FILL, (69, 94, 177): PANEL_SHADE}).save(os.path.join(out, 'gui-panel.png'))

button = gui_src('dragonButtonA-Sheet.png').crop((0, 0, 100, 35))
for state, fill, shade in [
    ('rest', (34, 38, 56), (26, 28, 44)),
    ('hover', (52, 60, 92), (38, 42, 68)),
    ('selected', (96, 66, 24), (70, 46, 20)),
    ('disabled', (28, 30, 38), (22, 24, 30)),
    ('primary', (237, 230, 211), (200, 190, 166)),        # bone: the one button that commits (UX: Confirm)
    ('primary-hover', (250, 246, 234), (222, 214, 192)),
]:
    im = refill(button, {(191, 91, 86): fill, (150, 68, 99): shade})
    if state == 'disabled':  # dim the gold frame too
        px = im.load()
        for y in range(im.height):
            for x in range(im.width):
                r, g, b, a = px[x, y]
                if a:
                    v = int(0.3 * r + 0.59 * g + 0.11 * b)
                    px[x, y] = ((v + 2 * 30) // 3, (v + 2 * 30) // 3, (v + 2 * 40) // 3, a)
    im.save(os.path.join(out, f'gui-button-{state}.png'))

# HUD at 1 lp (UX readability §8): action tabs, timeline chips, small plates and buttons.
tab = gui_src('dragonTabC-Sheet.png')  # 4 frames of 42x22: rest, hover, pressed, disabled
for i in range(4):
    tab.crop((i * 42, 0, i * 42 + 42, 22)).save(os.path.join(out, f'gui-tab-{i}.png'))
chip = gui_src('dragonFilledFrame-Sheet.png')  # 4 frames of 32x32
for i in range(4):
    chip.crop((i * 32, 0, i * 32 + 32, 32)).save(os.path.join(out, f'gui-chip-{i}.png'))
gui_src('dragon9SlicesC.png').save(os.path.join(out, 'gui-plate.png'))
for name, key in [('dragonLessButton-Sheet.png', 'gui-less'), ('dragonMoreButton-Sheet.png', 'gui-more'),
                  ('dragonLeftArrowButton-Sheet.png', 'gui-left'), ('dragonRightArrowButton-Sheet.png', 'gui-right'),
                  ('dragonOptionsButton-Sheet.png', 'gui-options'), ('dragonHelpButton-Sheet.png', 'gui-help')]:
    gui_src(name).save(os.path.join(out, f'{key}.png'))

# Camera buttons in the Less/More family (Art, #47 review): the Less sheet with its minus erased and an
# 8x8 glyph stamped in the pack's own glyph ink (light fill, darker 1 px shade above), on all 4 frames.
# Turn arrows read better than curls at 8 px: a 2 px shaft with a left-pointing head (rotate left).
ROTL = ['..#.....',
        '.##.....',
        '#######.',
        '#######.',
        '.##..##.',
        '..#..##.',
        '.....##.',
        '.....##.']
GLYPHS = {
    'gui-rotl': ROTL,
    'gui-rotr': [r[::-1] for r in ROTL],
    'gui-centre': ['..####..',
                   '.##..##.',
                   '##....##',
                   '#..##..#',
                   '#..##..#',
                   '##....##',
                   '.##..##.',
                   '..####..'],
}
less = gui_src('dragonLessButton-Sheet.png').convert('RGBA')
more = gui_src('dragonMoreButton-Sheet.png').convert('RGBA')
lp, mp = less.load(), more.load()
blank = less.copy()
bp = blank.load()
glyph_box = []
for f in range(4):
    ox = f * 16
    # Pixels where Less and More differ belong to the plus. Fill its box from the face pixel to the
    # left on each row, which leaves a plain face with the pack's edges intact.
    # The two glyphs share their horizontal bar, so clear the whole box the plus spans.
    diff = {(x, y) for x in range(16) for y in range(16) if lp[ox + x, y] != mp[ox + x, y]}
    xs, ys = [x for x, _ in diff], [y for _, y in diff]
    box = (min(xs), min(ys), max(xs), max(ys))
    inside = lambda x, y: box[0] <= x <= box[2] and box[1] <= y <= box[3]
    face = Counter(lp[ox + x, y] for x in range(3, 13) for y in range(3, 11) if not inside(x, y)).most_common(1)[0][0]
    ink = Counter(mp[ox + x, y] for (x, y) in diff).most_common(1)[0][0]
    # Flatten the whole 8x8 glyph cell around the plus centre, so no trace of the minus remains.
    cx, cy = (box[0] + box[2] + 1) // 2, (box[1] + box[3] + 1) // 2
    for y in range(max(2, cy - 4), min(12, cy + 4)):
        for x in range(max(2, cx - 4), min(14, cx + 4)):
            bp[ox + x, y] = face
    glyph_box.append((box, ink))
for key, rows in GLYPHS.items():
    im = blank.copy()
    px = im.load()
    for f in range(4):
        ox = f * 16
        (x0, y0, x1, y1), ink = glyph_box[f]  # the plus's own ink on this frame
        cx, cy = (x0 + x1 + 1) // 2, (y0 + y1 + 1) // 2
        for gy, row in enumerate(rows):
            for gx, c in enumerate(row):
                if c == '#':
                    px[ox + cx - 4 + gx, cy - 4 + gy] = ink
    im.save(os.path.join(out, f'{key}.png'))

print('ok', len(os.listdir(out)), 'files')
