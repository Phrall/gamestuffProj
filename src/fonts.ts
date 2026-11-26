import '@fontsource/tiny5/400.css';
import '@fontsource/pixelify-sans/400.css';
import glyphsUrl from '../assets/fonts/OathGlyphs.woff2?url';

/**
 * Pixel fonts (Art, UX readability §6): Tiny5 at 8 base px for body and stats, Pixelify Sans at 16 base px
 * for headers, preview numbers and banners. OathGlyphs (tools/fonts/build_glyphs.py) fills the symbols both
 * lack (→ ✓ ☠ ▶ …) on the same pixel grid. Sizes are only ever whole multiples of the native size.
 */
export const BODY = "'Tiny5', 'OathGlyphs', monospace";
export const HEAD = "'Pixelify Sans', 'OathGlyphs', sans-serif";

/** Layout units per base pixel (the HUD is laid out at 1280x720 = 2x the 640x360 base). */
const LP = 2;
export const BODY_PX = 8 * LP; // Tiny5 native 8 px
export const HEAD_PX = 16 * LP; // Pixelify Sans at 16 px

/**
 * Map a requested size (old layout px) onto the pixel scale: small text is Tiny5 at 8 lp, mid sizes
 * are Pixelify at 16 lp, and banners are Pixelify at 32 lp.
 */
export function pixelFont(size: number): { fontFamily: string; fontSize: string } {
  if (size <= 18) return { fontFamily: BODY, fontSize: `${BODY_PX}px` };
  if (size <= 40) return { fontFamily: HEAD, fontSize: `${HEAD_PX}px` };
  return { fontFamily: HEAD, fontSize: `${HEAD_PX * 2}px` };
}

/** Wait until the faces can draw, so no Text is measured with a fallback font. */
export async function loadFonts(): Promise<void> {
  try {
    const glyphs = new FontFace('OathGlyphs', `url(${glyphsUrl})`);
    document.fonts.add(await glyphs.load());
    await Promise.all([document.fonts.load(`${BODY_PX}px Tiny5`), document.fonts.load(`${HEAD_PX}px "Pixelify Sans"`)]);
  } catch {
    /* fall back to the system font rather than block the game */
  }
}
