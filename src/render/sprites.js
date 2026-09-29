// Hand-authored pixel sprites (as character maps) for characters, enemies,
// bosses, world objects and pickups. Built once into canvases and cached.

import { spriteFromMap, flipped, tinted, silhouette, scaled } from './canvas.js';
import { shadeHex } from '../weapons/visuals.js';

const OUTLINE = '#161622';

const PLAYER_BODY = [
  '...oooo...',
  '..ohhhho..',
  '.ohhhhhho.',
  '.ohseseho.',
  '.ohssssho.',
  '..osssso..',
  '.occcccco.',
  'oscccccCso',
  'oscbbbbCso',
  '.occcccCo.',
];
const PLAYER_LEGS = [
  ['.olloollo.', '.olloollo.', '.ooo..ooo.'],
  ['.olloollo.', '.ooo.ollo.', '......ooo.'],
  ['.olloollo.', '.ollo.ooo.', '.ooo......'],
];

const MAPS = {
  slime: [
    '...oooo...',
    '..ogwggo..',
    '.ogwggggo.',
    '.oggegeggo',
    'oggggggggo',
    'oGggggggGo',
    'oGGGGGGGGo',
    '.oooooooo.',
  ],
  bat: [
    'o....oo....o',
    'oo..obbo..oo',
    'oWwobebeowWo',
    'oWWWbbbbWWWo',
    '.oWo.oo.oWo.',
    '..o......o..',
  ],
  skeleton: [
    '...oooo...',
    '..owwwwo..',
    '.owewwewo.',
    '.owwwwwwo.',
    '..owkwko..',
    '...owwo...',
    '..oowwoo..',
    '.owokwowo.',
    '.owowwowo.',
    '..okwwko..',
    '..ow..wo..',
    '..ow..wo..',
    '..oo..oo..',
  ],
  brute: [
    '....oooooo....',
    '...orrrrrro...',
    '..orrerrerro..',
    '..orrrrrrrro..',
    '..orRttttRro..',
    '.oorrrrrrrroo.',
    'orrorrrrrrorro',
    'orrorrRRrrorro',
    'orrorrrrrrorro',
    '.oo.obbbbo.oo.',
    '....orrrro....',
    '...orro.orro..',
    '...ooo...ooo..',
  ],
  wisp: [
    '...oo...',
    '..owwo..',
    '.owwwwo.',
    '.oewewo.',
    'owwwwwwo',
    'oWwwwwWo',
    '.oWwwWo.',
    '..oWWo..',
    '...Wo...',
    '....W...',
  ],
  titan: [
    '..oo..........oo..',
    '.ohho........ohho.',
    '.ohhoooooooooohho.',
    '..orrrrrrrrrrrro..',
    '..orrrrrrrrrrrro..',
    '..orreerrrreerro..',
    '..orrrrrrrrrrrro..',
    '..orrRttttttRrro..',
    '...orrrrrrrrrro...',
    '.oooggrrrrrrggooo.',
    'orrrggrrrrrrggrrro',
    'orrroggggggggorrro',
    'orrrorrrrrrrrorrro',
    'orrrorrRRRRrrorrro',
    '.ooo.orrrrrro.ooo.',
    '.....orrrrrro.....',
    '....orrro.orrro...',
    '....orrro.orrro...',
    '...orrrro.orrrro..',
    '...oooooo.oooooo..',
  ],
  specter: [
    '......oooooo......',
    '....oohhhhhhoo....',
    '...ohhhhhhhhhho...',
    '..ohhhhhhhhhhhho..',
    '..ohhoooooooohho..',
    '..ohoeerrrreeoho..',
    '..ohorrrrrrrroho..',
    '..ohhorrrrrrohho..',
    '.ohhhhoooooohhhho.',
    'orhhhhhhhhhhhhhhro',
    'orrhhhhhhggghhhrro',
    '.orhhhhhhggghhhro.',
    '.oohhhhhhhhhhhhoo.',
    '..ohhhhhhhhhhhho..',
    '..ohhhhhhhhhhhho..',
    '..ohhHhhhhhHhhho..',
    '...ohHhhHhhHhho...',
    '...ohoHhoHhoHo....',
    '....o.oo.oo.oo....',
  ],
  chest: [
    '.oooooooooo.',
    'owwwwwwwwwwo',
    'owkkkkkkkkwo',
    'oyyyyoyyyyyo',
    'owwwoGGowwwo',
    'owwwwooowwwo',
    'owkkkkkkkkwo',
    'owwwwwwwwwwo',
    'oooooooooooo',
  ],
  chestOpen: [
    '.oooooooooo.',
    'okkkkkkkkkko',
    'oooooooooooo',
    'o.GGG.G.GG.o',
    'owwwoyyowwwo',
    'owwwwooowwwo',
    'owkkkkkkkkwo',
    'owwwwwwwwwwo',
    'oooooooooooo',
  ],
  shrine: [
    '...oooo...',
    '..oGGGGo..',
    '..oGgGGo..',
    '...oGGo...',
    '....oo....',
    '..oooooo..',
    '..owwwwo..',
    '..owkwwo..',
    '..owwwko..',
    '..owwwwo..',
    '.oooooooo.',
    'owwwwwwwwo',
    'oooooooooo',
  ],
  altar: [
    '....oooooooo....',
    '...owwwwwwwwo...',
    '..owGwwGGwwGwo..',
    '.owwwwwwwwwwwwo.',
    'oooooooooooooooo',
    'owkwwwwGGwwwwkwo',
    'owwwwwGggGwwwwwo',
    'owkwwwwGGwwwwkwo',
    'oooooooooooooooo',
  ],
  campfire: [
    '....oo....',
    '...oyo....',
    '..oyryo...',
    '..oyrryo..',
    '.oyrrryo..',
    '.oybbbyyo.',
    'owwbwwbwwo',
    '.oooooooo.',
  ],
  essence: [
    '..o..',
    '.oGo.',
    'oGgGo',
    'oGGGo',
    '.oGo.',
    '..o..',
  ],
  scrap: [
    '.o.o.',
    'owowo',
    '.owo.',
    'owowo',
    '.o.o.',
  ],
  component: [
    '..ooo..',
    '.oGgGo.',
    'oGgwgGo',
    'oGGgGGo',
    '.oGGGo.',
    '..ooo..',
  ],
  shard: [
    '...o...',
    '..oGo..',
    'ooGwGoo',
    'oGgwgGo',
    '.oGgGo.',
    '.oGogo.',
    'oGo.oGo',
    'oo...oo',
  ],
  gold: [
    '.ooo.',
    'oGgGo',
    'ogGGo',
    'oGGGo',
    '.ooo.',
  ],
  wood: [
    '.oooooo.',
    'obbbbbwo',
    'oBBBBBwo',
    '.oooooo.',
  ],
  stone: [
    '..ooo..',
    '.owwwo.',
    'owwwkko',
    'okkkkko',
    '.ooooo.',
  ],
  heart: [
    '.oo.oo.',
    'orrorro',
    'orwrrro',
    '.orrro.',
    '..oro..',
    '...o...',
  ],
  weaponDrop: [
    '...oo...',
    '..oGGo..',
    '.oGwwGo.',
    'oGwwwwGo',
    '.oGwwGo.',
    '..oGGo..',
    '...oo...',
  ],
};

const cache = new Map();

function build(key, fn) {
  let v = cache.get(key);
  if (!v) {
    v = fn();
    cache.set(key, v);
  }
  return v;
}

/** Player sprite frames: { right: [c0,c1,c2], left: [...], flash }. */
export function playerSprites(cloak = '#3f6fd8') {
  return build(`player:${cloak}`, () => {
    const palette = {
      o: OUTLINE, h: cloak, s: '#f2c29b', e: OUTLINE,
      c: shadeHex(cloak, 0.25), C: shadeHex(cloak, -0.3), b: '#6b4a2a', l: '#3a3a52',
    };
    const right = PLAYER_LEGS.map((legs) => spriteFromMap([...PLAYER_BODY, ...legs], palette));
    return { right, left: right.map(flipped), flash: silhouette(right[0]) };
  });
}

const ENEMY_PALETTES = {
  slime: (c) => ({ o: OUTLINE, g: c, G: shadeHex(c, -0.3), w: shadeHex(c, 0.6), e: OUTLINE }),
  bat: (c) => ({ o: OUTLINE, b: c, W: shadeHex(c, -0.3), w: shadeHex(c, 0.3), e: '#ff4040' }),
  skeleton: (c) => ({ o: OUTLINE, w: c, k: shadeHex(c, -0.55), e: '#ff5050' }),
  brute: (c) => ({ o: OUTLINE, r: c, R: shadeHex(c, -0.3), t: '#fff4d8', e: '#ffe040', b: '#5a3a22' }),
  wisp: (c) => ({ o: OUTLINE, w: c, W: shadeHex(c, -0.25), e: '#ffffff' }),
};

/** Enemy sprite set { right, left, flash } tinted with `color`. */
export function enemySprites(kind, color) {
  return build(`enemy:${kind}:${color}`, () => {
    const map = MAPS[kind] ?? MAPS.slime;
    const pal = (ENEMY_PALETTES[kind] ?? ENEMY_PALETTES.slime)(color);
    const right = spriteFromMap(map, pal);
    return { right, left: flipped(right), flash: silhouette(right) };
  });
}

const BOSS_SHAPES = {
  inferno_titan: 'titan',
  storm_colossus: 'titan',
  frost_warden: 'specter',
  void_herald: 'specter',
};

export function bossSprites(bossId, color) {
  return build(`boss:${bossId}`, () => {
    const shape = BOSS_SHAPES[bossId] ?? 'titan';
    const pal = {
      o: OUTLINE, r: color, R: shadeHex(color, -0.35), h: shape === 'titan' ? '#f4e8c8' : shadeHex(color, -0.15),
      H: shadeHex(color, -0.45), e: '#ffffff', t: '#fff4d8', g: shadeHex(color, 0.5),
    };
    const base = spriteFromMap(MAPS[shape], pal);
    const right = scaled(base, 2);
    return { right, left: flipped(right), flash: silhouette(right) };
  });
}

export function objectSprite(kind, accent = '#ffd24a') {
  return build(`obj:${kind}:${accent}`, () => {
    const pal = {
      o: OUTLINE, w: '#8d8a9e', k: '#5d5a6e', y: '#e0b040', G: accent, g: shadeHex(accent, 0.5),
      r: '#ff6a2a', b: '#6b4a2a',
    };
    if (kind === 'chest' || kind === 'chestOpen') {
      Object.assign(pal, { w: '#a8743e', k: '#6a4424', y: '#e0b040', G: '#ffd24a' });
    }
    return spriteFromMap(MAPS[kind], pal);
  });
}

export function pickupSprite(kind, color) {
  return build(`pickup:${kind}:${color}`, () => {
    const pal = { o: OUTLINE, G: color, g: shadeHex(color, 0.55), w: '#ffffff', r: '#e8364a' };
    if (kind === 'scrap') pal.w = '#b8bcc8';
    if (kind === 'wood') Object.assign(pal, { b: '#b07a48', B: '#7a4a28', w: '#e8c890' });
    if (kind === 'stone') Object.assign(pal, { w: '#b8bcc8', k: '#7d7a8e' });
    return spriteFromMap(MAPS[kind], pal);
  });
}

const tintCache = new WeakMap();

/** Cached tinted variant of any sprite canvas (status effects, elites). */
export function tintedSprite(canvas, color, amount = 0.6) {
  let byColor = tintCache.get(canvas);
  if (!byColor) {
    byColor = new Map();
    tintCache.set(canvas, byColor);
  }
  const key = `${color}:${amount}`;
  let out = byColor.get(key);
  if (!out) {
    out = tinted(canvas, color, amount);
    byColor.set(key, out);
  }
  return out;
}
