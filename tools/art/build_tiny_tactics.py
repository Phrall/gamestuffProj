"""Copy the Tiny Tactics / Pixel Bow Pack files the game uses into assets/art/tiny-tactics/
and make the Oathcourt recolours (pale grey and gold), per Art's mapping in
/mnt/project-files/oathbound/art/packs/README.md.

Usage: python3 -I tools/art/build_tiny_tactics.py <packs dir> <out dir>
"""
import glob
import os
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

print('ok', len(os.listdir(out)), 'files')
