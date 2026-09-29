// Tiny 3×5 bitmap font for in-world numbers (damage, heals). Drawing text
// into the low-res game buffer keeps it crisp and on the pixel grid.

const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '011', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
  '-': ['000', '000', '111', '000', '000'],
  '!': ['010', '010', '010', '000', '010'],
  x: ['000', '101', '010', '101', '000'],
};

export function textWidth(text) {
  return text.length * 4 - 1;
}

/** Draws `text` with a 1px dark outline at integer game-pixel coords. */
export function drawPixelText(ctx, text, x, y, color, outline = '#161622') {
  x = Math.round(x - textWidth(text) / 2);
  y = Math.round(y);
  for (const pass of [0, 1]) {
    ctx.fillStyle = pass ? color : outline;
    let cx = x;
    for (const ch of text) {
      const g = GLYPHS[ch];
      if (g) {
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 3; c++) {
            if (g[r][c] !== '1') continue;
            if (pass) ctx.fillRect(cx + c, y + r, 1, 1);
            else ctx.fillRect(cx + c - 1, y + r - 1, 3, 3);
          }
        }
      }
      cx += 4;
    }
  }
}
