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


def oathcourt(im):
    """Pale grey with gold trim: keep the dark outline, map light to pale grey,
    and turn the pack's most saturated bright pixels (hair, trim) gold."""
    im = im.convert('RGBA')
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
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
    import colorsys
    im = im.convert('RGBA')
    px = im.load()
    ramp = [(0x5A, 0x3A, 0x2E), (0x7E, 0x50, 0x38), (0xA8, 0x74, 0x4E)]
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if 0.85 <= h <= 0.99 and s > 0.4 and l > 0.25:
                px[x, y] = (*ramp[0 if l < 0.42 else 1 if l < 0.58 else 2], a)
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
print('ok', len(os.listdir(out)), 'files')
