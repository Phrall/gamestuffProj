"""Build OathGlyphs: the few symbols Tiny5 and Pixelify Sans lack (arrows, ✓, ☠, ▶…), drawn on Tiny5's
8 px grid (128 units per pixel at 1024 upm) so the browser's per-glyph fallback stays pixel-crisp.
Art: draw missing symbols as tiny pixel glyphs rather than mixing in another typeface.

Usage: python3 -I tools/fonts/build_glyphs.py assets/fonts/OathGlyphs.woff2
"""
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

PX = 128
GLYPHS = {
    '→': ['..#..', '...#.', '#####', '...#.', '..#..'],
    '▶': ['#..', '##.', '###', '##.', '#..'],
    '◀': ['..#', '.##', '###', '.##', '..#'],
    '▼': ['#####', '.###.', '..#..'],
    '▲': ['..#..', '.###.', '#####'],
    '☠': ['.###.', '#####', '#.#.#', '#####', '.#.#.'],
    '✓': ['....#', '...##', '#.##.', '###..', '.#...'],
    '⚠': ['..#..', '.###.', '.#.#.', '#####', '##.##'],
    '♪': ['..##', '..#.', '..#.', '..#.', '###.', '##..'],
    '↗': ['.####', '...##', '..#.#', '.#..#', '#....'],
    '↘': ['#....', '.#..#', '..#.#', '...##', '.####'],
    '↙': ['....#', '#..#.', '#.#..', '##...', '####.'],
    '↖': ['####.', '##...', '#.#..', '#..#.', '....#'],
    '⟲': ['#.##.', '##..#', '###.#', '....#', '.###.'],
    '⟳': ['.##.#', '#..##', '#.###', '#....', '.###.'],
    '◎': ['.###.', '#...#', '#.#.#', '#...#', '.###.'],
    '≥': ['#....', '.##..', '...##', '.##..', '#....', '#####'],
}
# Vertical placement: rows sit on the baseline unless listed (▼/▲ centred on the x-height).
LIFT = {'▼': 1, '▲': 1}


def glyph(rows, lift):
    pen = TTGlyphPen(None)
    h = len(rows)
    for r, line in enumerate(rows):
        y = (h - 1 - r + lift) * PX
        for c, ch in enumerate(line):
            if ch != '#':
                continue
            x = (c + 1) * PX  # 1 px left bearing, like Tiny5
            pen.moveTo((x, y)); pen.lineTo((x, y + PX)); pen.lineTo((x + PX, y + PX)); pen.lineTo((x + PX, y)); pen.closePath()
    return pen.glyph()


def main(out):
    names = ['.notdef'] + [f'uni{ord(ch):04X}' for ch in GLYPHS]
    fb = FontBuilder(1024, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({ord(ch): f'uni{ord(ch):04X}' for ch in GLYPHS})
    glyphs = {'.notdef': TTGlyphPen(None).glyph()}
    metrics = {'.notdef': (512, 0)}
    for ch, rows in GLYPHS.items():
        n = f'uni{ord(ch):04X}'
        glyphs[n] = glyph(rows, LIFT.get(ch, 0))
        metrics[n] = ((max(len(r) for r in rows) + 2) * PX, PX)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=896, descent=-256)
    fb.setupNameTable({'familyName': 'OathGlyphs', 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=896, sTypoDescender=-256, usWinAscent=896, usWinDescent=256, sCapHeight=640, sxHeight=512)
    fb.setupPost()
    fb.font.flavor = 'woff2'
    fb.save(out)
    print('ok', len(GLYPHS), 'glyphs ->', out)


if __name__ == '__main__':
    main(sys.argv[1])
