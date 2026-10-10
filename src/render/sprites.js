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
  // Shark cutting through the water (head right): fin up, body just under the surface.
  shark: [
    '........o..........',
    '........oFo........',
    '........oFFo.......',
    '........oFFFo......',
    'oo..oooooFFFooooo..',
    'oBooBBBBBBBBBBBBBo.',
    'oBBBbbbbbbbbbbbbbBo',
    'oBoBBbbbbbbbWbbbBo.',
    'oo..ooooooooooooo..',
  ],
  // Sea serpent head (right-facing): a crest of spines, jaw with teeth.
  serpent: [
    '..o.o.o.......',
    '.oCoCoCo......',
    '.oSSSSSSoo....',
    'oSSSSSSSSSoo..',
    'oSSeSSSSSSSSo.',
    'oSSSSSSSSSSSSo',
    'osssssSSSSStto',
    '.osssssSSSSSo.',
    '..oosssssoo...',
    '....ooooo.....',
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
  // Frost Warden: a crowned knight in ice armour with a great shield.
  warden: [
    '.......oooo.......',
    '......ohhhho......',
    '.....ohHHHHho.....',
    '....oHHHHHHHHo....',
    '....oHooooooHo....',
    '....oHoeeoeeHo....',
    '....oHHHHHHHHo....',
    '.....oHHHHHHo.....',
    '..oooorrrrrroooo..',
    '.ohhhorrrrrrohhhho',
    'ohhhhorrRRrrohggho',
    '.oooorrrrrrrohggho',
    '...orrrrrrrrohhhho',
    '...orrRRRRrrohhhho',
    '...orrrrrrrro.oo..',
    '...oRRRRRRRRo.....',
    '....orrro.orrro...',
    '....orrro.orrro...',
    '...ohhhho.ohhhho..',
    '...oooooo.oooooo..',
  ],
  // The Prism Warden: a floating crystal guardian with a burning gold core.
  prism: [
    '........oo........',
    '.......ohho.......',
    '......ohrrvo......',
    '.....ohrrrvvo.....',
    '....ohrrrrrvvo....',
    '....orrreerrvo....',
    '.....orrrrrvo.....',
    '..o...orrrro...o..',
    '.oho.oorrrroo.ovo.',
    'ohhoohrrrrrrvoovvo',
    '.oo.ohrrRRrrvo.oo.',
    '....ohrrRRrrvo....',
    '....ohrryyrrvo....',
    '....ohrrRRrrvo....',
    '.....ohrrrrvo.....',
    '......ohrrvo......',
    '.......orro.......',
    '........oo........',
    '..g..........g....',
  ],
  // The Mireheart: a swollen heart of the bog on a tangle of roots, glowing within.
  mireheart: [
    '.......oooo.......',
    '.....oogggGoo.....',
    '....ogGGgggGGo....',
    '...ogGGeggeGGGo...',
    '..ogGGGggggGGGGo..',
    '..oGGGgggggggGGo..',
    '.ooGGgRRRRRRgGGoo.',
    'oggGgRRyyyyRRgGggo',
    'oGGGgRRyyyyRRgGGGo',
    '.oGGgRRRRRRRRgGGo.',
    '..oGGgggggggggGo..',
    '...oGGGGgggGGGo...',
    '..oo.oGGGGGGo.oo..',
    '.oRo..oRooRo..oRo.',
    'oRo..oRo..oRo..oRo',
    'oo..oRo....oRo..oo',
    '...oo........oo...',
  ],
  // The Aether Roc: a great bird with its wings spread.
  roc: [
    '........oo........',
    '.......ohho.......',
    '......ohehho......',
    '......ohhhyo......',
    'oo....ohhhho....oo',
    'owoo..orrrro..oowo',
    'owwwoorrrrrroowwwo',
    '.owwwwrrrrrrwwwwo.',
    '..owwwrrRRrrwwwo..',
    '...oowrrRRrrwoo...',
    '.....orrrrrro.....',
    '......orrrro......',
    '.....owo..owo.....',
    '.....oyo..oyo.....',
    '......o....o......',
  ],
  // Sand Wyrm: a segmented worm rearing out of a sand mound.
  wyrm: [
    '......oooooo......',
    '....oorrrrrroo....',
    '...orrrrrrrrrro...',
    '..orreerrrreerro..',
    '..orrrrrrrrrrrro..',
    '.otorrrrrrrrrroto.',
    'ottoorRtRRtRroott.',
    '.oo.orrrrrrrro.oo.',
    '....ohhhhhhhho....',
    '....orrrrrrrro....',
    '.....ohhhhhho.....',
    '.....orrrrrro.....',
    '....ohhhhhhhho....',
    '....orrrrrrrro....',
    '..oossssssssssoo..',
    '.osssSssssssSsssso',
    'osssssssSsssssssso',
    'oooooooooooooooooo',
  ],
  // Thornmother: a bark-skinned tree hag crowned with flowers.
  thorn: [
    '...o.oo....oo.o...',
    '..oyoyyo..oyyoyo..',
    '...oyyo....oyyo...',
    '....oo.oooo.oo....',
    '.t...ohhhhhho...t.',
    '.ot.ohheehheho.to.',
    '..ohhhhhhhhhhhho..',
    '.ohho.ohhhho.ohho.',
    'ohho.ohrrrrho.ohho',
    'oho..orrggrro..oho',
    '.o...orrggrro...o.',
    '.....orrrrrro.....',
    '....ohrrrrrrho....',
    '...ohhRrrrrRhho...',
    '..ohho.oooo.ohho..',
    '.ohho........ohho.',
    'oho............oho',
    'oo..............oo',
  ],
  // Bone King: a crowned skeleton in a blood-red robe.
  lich: [
    '....o.o.oo.o.o....',
    '....ogogggggogo...',
    '....oggggggggo....',
    '....ohhhhhhhho....',
    '...ohhoohhoohho...',
    '...ohoeeohoeeoho..',
    '...ohhhhoohhhhho..',
    '....ohtttttttho...',
    '..oooohhhhhhoooo..',
    '.ohhhorrrrrrohhho.',
    'ohhhorrrhhrrrohhho',
    'oho.orrrhhrrro.oho',
    'oho.orRrrrrRro.oho',
    '.o..orrrrrrrro..o.',
    '....orRrrrrRro....',
    '...orrrrrrrrrro...',
    '..orrRrrrrrrRrro..',
    '..oRRoRRRRRRoRRo..',
    '..ooo.oooooo.ooo..',
  ],
  // Tide Leviathan: a finned sea beast rising from the waves.
  leviathan: [
    '...o..........o...',
    '..ogo........ogo..',
    '..oggo.oooo.oggo..',
    '...oggorrrrroggo..',
    '....orrrrrrrrro...',
    '...orreerrreerro..',
    '...orrrrrrrrrrro..',
    '..otrrrrrrrrrrtro.',
    '..ottohhhhhhottoo.',
    '...oohhhhhhhhoo...',
    '....orrrrrrrro....',
    '...ohhhhhhhhhho...',
    '..orrrrrrrrrrrro..',
    '.owwwrrrrrrrrwwwo.',
    'owWWWwwrrrrwwWWWwo',
    'oWWWWWWwwwwWWWWWWo',
    'oooooooooooooooooo',
  ],
  // Storm Colossus: a floating stone golem with a lightning core.
  colossus: [
    '......oooooo......',
    '....oohhhhhhoo....',
    '...ohhHhhhhHhho...',
    '...ohheehheehho...',
    '...ohhhhhhhhhho...',
    '....oHHggggHHo....',
    '.oo..oooooooo..oo.',
    'ohho.ohhrrhho.ohho',
    'ohgo.ohrggrho.ogho',
    'ohho.ohrggrho.ohho',
    '.oo..ohhrrhho..oo.',
    '.....ohhhhhho.....',
    '......ohhhho......',
    '.......oggo.......',
    '........og........',
    '.......go.........',
    '........g.........',
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
  bones: [
    '....ooo.....',
    '...oWWWo....',
    '...oWoWo....',
    '....oWo.....',
    '.oo..o...oo.',
    'oWWoooooooWo',
    '.ooWWWWWWoo.',
    '...oooooo...',
  ],
  signpost: [
    '.oooooooo..',
    'obbbbbbbbo.',
    'obBBbBBBbbo',
    'obbbbbbbbo.',
    '.oooobooo..',
    '....obo....',
    '....obo....',
    '....obo....',
    '...ooboo...',
    '...ooooo...',
  ],
  mushrooms: [
    '.ooo....ooo.',
    'oGgGo..oGgGo',
    'ooWoo..ooWoo',
    '.oWo.oo.oWo.',
    '..o.oGGo.o..',
    '....ooWo....',
    '.....oo.....',
  ],
  bottle: [
    '.ooooo..',
    'ouuuuuoo',
    'ouWWuuob',
    'ouuuuuoo',
    '.ooooo..',
  ],
  wreck: [
    '.........o..........',
    '........obo.........',
    '........obo..oo.....',
    '...o....obo.oWWo....',
    '..oboooooboooWWo....',
    '.obbbbbbbbbbbooo..o.',
    'obBbBbBbBbBbBbbo.obo',
    'oBbBbBbBbBbBboo..oo.',
    '.oooooooooooo.......',
  ],
  idol: [
    '..oooooo..',
    '.owwwwwwo.',
    '.owGwwGwo.',
    '.owwwwwwo.',
    '.owkkkkwo.',
    '.owkwwkwo.',
    '..owwwwo..',
    '.oowwwwoo.',
    'owwwwwwwwo',
    'owkwwwwkwo',
    'owwwwwwwwo',
    '.owwkkwwo.',
    '.owwwwwwo.',
    'oooooooooo',
  ],
  treasure: [
    'rr.....rr',
    '.rr...rr.',
    '..rr.rr..',
    '...rrr...',
    '..rr.rr..',
    '.rr...rr.',
    'rr.....rr',
  ],
  hole: [
    '..ooooo..',
    '.obbbbbo.',
    'obkkkkkbo',
    '.obbbbbo.',
    '..ooooo..',
  ],
  campOut: [
    '....kk....',
    '...kkkk...',
    '.okbbbbko.',
    'owwbwwbwwo',
    '.oooooooo.',
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
  // The far lands' materials (G: the pickup's colour).
  prismite: [
    '..o..',
    '.oGo.',
    'oGwGo',
    'oGGgo',
    'oGggo',
    '.ooo.',
  ],
  spores: [
    '.ooo.',
    'oGwGo',
    'oGGgo',
    '.ogo.',
    '.o.o.',
  ],
  aether: [
    '..o..',
    '.owo.',
    'oGwGo',
    '.oGo.',
    '..o..',
  ],
  // A torn old map (a rare find: it shows a new part of the world).
  mapscroll: [
    '.oooooooo.',
    'oGwwwwwwGo',
    'owwrwwwwwo',
    'owwwwrwwwo',
    'owrwwwwrwo',
    'owwwwrwwwo',
    'oGwwwwwwGo',
    '.oooooooo.',
  ],
  // A dropped sack (multiplayer death bag).
  bag: [
    '...ooo...',
    '..oGwGo..',
    '...ogo...',
    '..oGGGo..',
    '.oGwGGGo.',
    'oGGGGGGGo',
    'oGGGGGGgo',
    'oGGGGGggo',
    '.oggggggo',
    '..ooooooo',
  ],
  egg: [
    '..ooo..',
    '.owwwo.',
    'owGwwwo',
    'owwwGwo',
    'oGwwwwo',
    'owwGwgo',
    '.owwwo.',
    '..ooo..',
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
  shark: (c) => ({ o: OUTLINE, F: shadeHex(c, 0.12), B: shadeHex(c, -0.35), b: shadeHex(c, -0.12), W: '#ffffff' }),
  serpent: (c) => ({ o: OUTLINE, S: c, s: shadeHex(c, 0.45), C: '#e8364a', e: '#ffe040', t: '#fff4d8' }),
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
  storm_colossus: 'colossus',
  frost_warden: 'warden',
  void_herald: 'specter',
  bone_king: 'lich',
  thornmother: 'thorn',
  sand_wyrm: 'wyrm',
  tide_leviathan: 'leviathan',
  prism_warden: 'prism',
  mireheart: 'mireheart',
  aether_roc: 'roc',
};

export function bossSprites(bossId, color) {
  return build(`boss:${bossId}`, () => {
    const shape = BOSS_SHAPES[bossId] ?? 'titan';
    const pal = {
      o: OUTLINE, r: color, R: shadeHex(color, -0.35), h: shape === 'titan' ? '#f4e8c8' : shadeHex(color, -0.15),
      H: shadeHex(color, -0.45), e: '#ffffff', t: '#fff4d8', g: shadeHex(color, 0.5),
    };
    // Ice-silver armour for the Warden, weathered stone for the Colossus.
    if (shape === 'warden') Object.assign(pal, { h: '#e8f4ff', H: '#6a8aa8', r: '#9fd8f4', R: '#5a8ab0', e: '#7affff', g: '#ffffff' });
    if (shape === 'colossus') Object.assign(pal, { h: '#9a9aa8', H: '#5d5d6e', r: color, g: '#fffbd0', e: '#ffe45c' });
    if (shape === 'wyrm') Object.assign(pal, { h: shadeHex(color, 0.3), e: '#ff5030', s: '#e8c890', S: '#b8905a' });
    if (shape === 'thorn') Object.assign(pal, { h: '#7a5232', H: '#4a3018', e: '#ffe45c', y: '#ff7ad8', g: '#c8f59a', t: '#e8e0c8' });
    if (shape === 'lich') Object.assign(pal, { h: '#e8e4d4', H: '#a8a090', e: '#ff4040', g: '#ffd24a', t: '#161622' });
    if (shape === 'leviathan') Object.assign(pal, { h: '#bfe8ff', g: '#7ad8ff', e: '#ffe45c', w: '#e8f8ff', W: '#3a78c8' });
    if (shape === 'prism') Object.assign(pal, { h: '#e8fbff', r: '#9ae8ff', R: '#5ab0d0', v: '#c09aff', y: '#ffd27a', e: '#ffffff', g: '#ffd27a' });
    if (shape === 'mireheart') Object.assign(pal, { g: '#4ac8a0', G: '#2a7a5a', R: '#5a3a22', y: '#d8ffb0', e: '#ffe45c' });
    if (shape === 'roc') Object.assign(pal, { h: '#f8f4e8', e: '#202030', r: '#e8d8a8', R: '#b8a070', w: '#c8e0f8', y: '#ffd24a' });
    const base = spriteFromMap(MAPS[shape], pal);
    const right = scaled(base, 2);
    return { right, left: flipped(right), flash: silhouette(right) };
  });
}

export function objectSprite(kind, accent = '#ffd24a') {
  return build(`obj:${kind}:${accent}`, () => {
    const pal = {
      o: OUTLINE, w: '#8d8a9e', k: '#5d5a6e', y: '#e0b040', G: accent, g: shadeHex(accent, 0.5),
      r: '#ff6a2a', b: '#6b4a2a', B: '#4a3018', W: '#ece4d0', u: '#7ac8e8', n: '#15121f',
    };
    if (kind === 'treasure') pal.r = '#d8342a';
    if (kind === 'wreck' || kind === 'signpost') Object.assign(pal, { b: '#8a5a33', B: '#5a3a1e' });
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
    if (kind === 'egg') Object.assign(pal, { w: '#f4ecd8', g: '#d8ccb0' });
    if (kind === 'mapscroll') Object.assign(pal, { w: '#ecdcb0', r: '#c8364a' });
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
