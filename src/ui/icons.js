// Pixel icon set for the UI, drawn from character maps (same approach as the
// game sprites) and turned into data URLs once. Keeps the interface in the
// game's pixel style instead of mixing in platform emoji.

import { h } from './dom.js';

const O = '#0e0c18';

const ICONS = {
  bag: {
    map: [
      '....oooo....',
      '...owwwwo...',
      '..owo..owo..',
      '.oooooooooo.',
      'obbbbbbbbbbo',
      'obbbbggbbbbo',
      'obbbbggbbbbo',
      'oBbbbbbbbbBo',
      'oBbbbbbbbbBo',
      'oBBbbbbbbBBo',
      '.oBBBBBBBBo.',
      '..oooooooo..',
    ],
    pal: { o: O, w: '#c8a878', b: '#b07a48', B: '#7a4a28', g: '#e8b84a' },
  },
  anvil: {
    map: [
      '............',
      '.ooooooooo..',
      'owwwwwwwwwoo',
      'oiiiiiiiiiio',
      '.oiiiiiiiioo',
      '..ooiiiioo..',
      '....oiio....',
      '...oiiiio...',
      '..oiiiiiio..',
      '.oIIIIIIIIo.',
      '.oooooooooo.',
      '............',
    ],
    pal: { o: O, w: '#b8bccc', i: '#6e7286', I: '#4a4e5e' },
  },
  book: {
    map: [
      '............',
      '.oooooooooo.',
      'orrrrrrrrrpo',
      'orryyyyrrrpo',
      'orrrrrrrrrpo',
      'orrrrrrrrrpo',
      'orrrrrrrrrpo',
      'orrrrrrrrrpo',
      'oRRRRRRRRRpo',
      'ooooooooooop',
      '.ppppppppppo',
      '.oooooooooo.',
    ],
    pal: { o: O, r: '#b8323a', R: '#7a1f28', y: '#e8b84a', p: '#f4ecd8' },
  },
  home: {
    map: [
      '.....oo.....',
      '....orro....',
      '...orrrro...',
      '..orrrrrro..',
      '.orrrrrrrro.',
      'oooooooooooo',
      '.owwwwwwwwo.',
      '.owwoooowwo.',
      '.owwoffowwo.',
      '.owwoffowwo.',
      '.owwoffowwo.',
      '.oooooooooo.',
    ],
    pal: { o: O, r: '#c8364a', w: '#c09060', f: '#ffb040' },
  },
  gear: {
    map: [
      '.....oo.....',
      '..o.owwo.o..',
      '.owoowwoowo.',
      '..owwwwwwo..',
      '.oowwoowwoo.',
      'owwwo..owwwo',
      'owwwo..owwwo',
      '.oowwoowwoo.',
      '..owwwwwwo..',
      '.owoowwoowo.',
      '..o.owwo.o..',
      '.....oo.....',
    ],
    pal: { o: O, w: '#b8bccc' },
  },
  heart: {
    map: [
      '..........',
      '.ooo..ooo.',
      'orrwoorrro',
      'orwrrrrrro',
      'orrrrrrrro',
      '.orrrrrro.',
      '..orrrro..',
      '...orro...',
      '....oo....',
      '..........',
    ],
    pal: { o: O, r: '#e8364a', w: '#ffb0b8' },
  },
  essence: {
    map: [
      '....oo....',
      '...owco...',
      '..owccco..',
      '.owccccco.',
      '.occccCco.',
      '.occcCCco.',
      '..occCCo..',
      '...oCCo...',
      '....oo....',
      '..........',
    ],
    pal: { o: O, w: '#ffffff', c: '#7ae0ff', C: '#3a8ab0' },
  },
  scrap: {
    map: [
      '...o..o...',
      '..owoowo..',
      '.owwwwwwo.',
      'owwoooowwo',
      '.owo..owo.',
      '.owo..owo.',
      'owwoooowwo',
      '.owwwwwwo.',
      '..owoowo..',
      '...o..o...',
    ],
    pal: { o: O, w: '#c8ccd8' },
  },
  sword: {
    map: [
      '.........oo',
      '........owo',
      '.......owwo',
      '......owwo.',
      '.....owwo..',
      '.o..owwo...',
      'oyo.owo....',
      '.oyoyo.....',
      '..oyo......',
      '.obooyo....',
      'obo..oo....',
      '.o.........',
    ],
    pal: { o: O, w: '#e8ecf4', y: '#e8b84a', b: '#8a5a33' },
  },
  hand: {
    map: [
      '....o.o.....',
      '...owowoo...',
      '...owowowo..',
      '.o.owowowo..',
      'owoowwwwwo..',
      'owwowwwwwo..',
      '.owwwwwwwo..',
      '..owwwwwwo..',
      '..owwwwwo...',
      '...owwwwo...',
      '...oooooo...',
      '............',
    ],
    pal: { o: O, w: '#f2c29b' },
  },
  boot: {
    map: [
      '............',
      '...ooooo....',
      '...obbbo....',
      '...obbbo....',
      '...obbbo..y.',
      '...obbbo.y..',
      '..obbbboy...',
      '.obbbbbbboo.',
      'obbbbbbbbbbo',
      'oBBBBBBBBBBo',
      '.oooooooooo.',
      '............',
    ],
    pal: { o: O, b: '#7ae0ff', B: '#3a8ab0', y: '#ffffff' },
  },
  star: {
    map: [
      '.....oo.....',
      '....oyyo....',
      '....oyyo....',
      'oooooyyooooo',
      'oyyyyyyyyyyo',
      '.oyyyyyyyyo.',
      '..oyyyyyyo..',
      '..oyyyyyyo..',
      '.oyyyoyyyyo.',
      '.oyyo.oyyyo.',
      'oyyo...oyyyo',
      'ooo.....oooo',
    ],
    pal: { o: O, y: '#ffd24a' },
  },
  close: {
    map: [
      '..........',
      '.oo....oo.',
      'owwo..owwo',
      '.owwoowwo.',
      '..owwwwo..',
      '..owwwwo..',
      '.owwoowwo.',
      'owwo..owwo',
      '.oo....oo.',
      '..........',
    ],
    pal: { o: O, w: '#f3ecdc' },
  },
  lock: {
    map: [
      '...oooo...',
      '..owwwwo..',
      '.owo..owo.',
      '.owo..owo.',
      'oooooooooo',
      'oyyyyyyyyo',
      'oyyyooyyyo',
      'oyyyooyyyo',
      'oYYYYYYYYo',
      'oooooooooo',
    ],
    pal: { o: O, w: '#b8bccc', y: '#e8b84a', Y: '#a87a20' },
  },
  chest: {
    map: [
      '............',
      '.oooooooooo.',
      'owwwwwwwwwwo',
      'owkkkkkkkkwo',
      'oyyyyooyyyyo',
      'owwwoyyowwwo',
      'owwwwoowwwwo',
      'owkkkkkkkkwo',
      'owwwwwwwwwwo',
      'oooooooooooo',
      '............',
      '............',
    ],
    pal: { o: O, w: '#b07a48', k: '#7a4a28', y: '#e8b84a' },
  },
  up: {
    map: [
      '....oo....',
      '...oggo...',
      '..oggggo..',
      '.oggggggo.',
      'ooooggoooo',
      '...oggo...',
      '...oggo...',
      '...oggo...',
      '...oooo...',
      '..........',
    ],
    pal: { o: O, g: '#6cd66c' },
  },
  // Two adventurers side by side (multiplayer).
  players: {
    map: [
      '.ooo....ooo.',
      'obbbo..orrro',
      'offfo..offfo',
      'offfo..offfo',
      '.ooo....ooo.',
      'obbbo..orrro',
      'obbbo..orrro',
      'obbbo..orrro',
      '.o.o....o.o.',
      '.o.o....o.o.',
    ],
    pal: { o: O, b: '#3f6fd8', r: '#c8364a', f: '#f0c8a0' },
  },
  // A small round creature with big eyes (pals).
  pal: {
    map: [
      '..o......o..',
      '.oGo....oGo.',
      '.oGGooooGGo.',
      'oGGGGGGGGGGo',
      'oGwwGGGGwwGo',
      'oGwkGGGGwkGo',
      'oGGGGrrGGGGo',
      '.oGGGGGGGGo.',
      '.ogGGGGGGgo.',
      '..oooooooo..',
    ],
    pal: { o: O, G: '#7ad86a', g: '#4f9a44', w: '#ffffff', k: '#161622', r: '#e8364a' },
  },
  skull: {
    map: [
      '..oooooo..',
      '.owwwwwwo.',
      'owwwwwwwwo',
      'owoowwoowo',
      'owoowwoowo',
      'owwwwwwwwo',
      '.owwoowwo.',
      '..owwwwo..',
      '..owowow..',
      '...ooooo..',
    ],
    pal: { o: O, w: '#f3ecdc' },
  },
  portal: {
    map: [
      '...oooooo...',
      '..orrrrrro..',
      '.orpppppppo.',
      'orppwwwwppro',
      'orpwppppwpro',
      'orpwpwwpwpro',
      'orpwpwwpwpro',
      'orpwppppwpro',
      'orppwwwwppro',
      '.orpppppppo.',
      '..orrrrrro..',
      '...oooooo...',
    ],
    pal: { o: O, r: '#8d8a9e', p: '#6b3fc6', w: '#cdb2ff' },
  },
  map: {
    map: [
      '............',
      'oooo.oooo.oo',
      'oppoopppooko',
      'opppopprpoko',
      'oppppprrpoko',
      'opgppppppoko',
      'oggpprppppko',
      'opppprrppoko',
      'oppppprpppko',
      'opppppppppko',
      'oooooooooooo',
      '............',
    ],
    pal: { o: O, p: '#e8d8a8', k: '#c8b888', g: '#6cd66c', r: '#e8364a' },
  },
  coin: {
    map: [
      '..oooooo..',
      '.oyyyyyyo.',
      'oyywwyyyYo',
      'oywyyyyyYo',
      'oyyyYYyyYo',
      'oyyyYYyyYo',
      'oyyyyyyyYo',
      'oYyyyyyYYo',
      '.oYYYYYYo.',
      '..oooooo..',
    ],
    pal: { o: O, y: '#ffd24a', Y: '#c9973f', w: '#fff4c0' },
  },
  shard: {
    map: [
      '....oo....',
      '...oyyo...',
      '..oywyyo..',
      'ooywwyyyoo',
      'oyyyyyyyYo',
      '.oyyyyyYo.',
      '..oyyyYo..',
      '.oyYooYYo.',
      '.oYo..oYo.',
      '.oo....oo.',
    ],
    pal: { o: O, y: '#ffd24a', Y: '#c9973f', w: '#fff8d8' },
  },
  pin: {
    map: [
      '..oooo..',
      '.orrrro.',
      'orrwwrro',
      'orrwwrro',
      '.orrrro.',
      '..orro..',
      '...oo...',
      '........',
    ],
    pal: { o: O, r: '#e8364a', w: '#ffffff' },
  },
  hammer: {
    map: [
      '............',
      '.oooooooooo.',
      '.owwwwwwwwo.',
      '.oWWWWWWWWo.',
      '.oooobboooo.',
      '....obbo....',
      '....obbo....',
      '....obbo....',
      '....obbo....',
      '....obbo....',
      '....oooo....',
      '............',
    ],
    pal: { o: O, w: '#d0d4e0', W: '#8d8a9e', b: '#b07a48' },
  },
  pickaxe: {
    map: [
      '..oooooooo..',
      '.owwwwwwwwo.',
      'owwoobboowwo',
      'owo.obbo.owo',
      'oo..obbo..oo',
      '....obbo....',
      '....obbo....',
      '....obbo....',
      '....obbo....',
      '....obbo....',
      '....oooo....',
      '............',
    ],
    pal: { o: O, w: '#b8bccc', b: '#b07a48' },
  },
  wood: {
    map: [
      '............',
      '.oooooooooo.',
      'obbbbbbbbooo',
      'obBBBBBBoyyo',
      'obbbbbbboyto',
      'oBBBBBBBoyyo',
      'obbbbbbbbooo',
      '.oooooooooo.',
      '............',
    ],
    pal: { o: O, b: '#b07a48', B: '#8a5a33', y: '#e8c890', t: '#b07a48' },
  },
  stone: {
    map: [
      '............',
      '....oooo....',
      '..oowwwwoo..',
      '.owwwwwkkko.',
      'owwwwwkkkkko',
      'owwwkkkkkkko',
      'okkkkkkkkKKo',
      '.oKKKKKKKKo.',
      '..oooooooo..',
    ],
    pal: { o: O, w: '#c8ccd8', k: '#8d8a9e', K: '#5d5a6e' },
  },
  remove: {
    map: [
      '..........',
      '.oo....oo.',
      'orro..orro',
      '.orroorro.',
      '..orrrro..',
      '..orrrro..',
      '.orroorro.',
      'orro..orro',
      '.oo....oo.',
      '..........',
    ],
    pal: { o: O, r: '#ff6a7a' },
  },
};

const urlCache = new Map();

function toDataUrl(name) {
  let url = urlCache.get(name);
  if (url) return url;
  const def = ICONS[name] ?? ICONS.gear;
  const h = def.map.length;
  const w = Math.max(...def.map.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const col = def.pal[def.map[y][x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  url = c.toDataURL();
  urlCache.set(name, url);
  return url;
}

/** <img> element for an icon, `size` in CSS pixels (integer multiple looks best). */
export function icon(name, size = 24, label = '') {
  const img = document.createElement('img');
  img.src = toDataUrl(name);
  img.width = size;
  img.height = size;
  img.className = 'icon pixel';
  img.alt = label;
  if (!label) img.setAttribute('aria-hidden', 'true');
  img.draggable = false;
  return img;
}

/** Replaces `[data-icon]` placeholders in static HTML with icons. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const size = Number(el.dataset.size ?? 24);
    el.replaceWith(icon(el.dataset.icon, size));
  }
}

/** Price tag: resource icon + amount, red when the player can't afford it. */
export const RESOURCE_NAMES = {
  scrap: 'Scrap', essence: 'Essence', wood: 'Wood', stone: 'Stone', gold: 'Gold', shards: 'Star Shards',
};
const RESOURCE_ICON = { gold: 'coin', shards: 'shard' };

export function resourceIcon(kind, size = 20) {
  return icon(RESOURCE_ICON[kind] ?? kind, size);
}

export function costChip(kind, amount, have = Infinity) {
  return h('span.cost', { class: have < amount ? 'short' : null, title: RESOURCE_NAMES[kind] ?? kind, 'data-kind': kind },
    resourceIcon(kind), Number(amount).toLocaleString());
}

/** Chips for every resource in a cost object ({ scrap, essence, wood, stone, gold, shards }). */
export function costChips(cost, resources = {}) {
  return ['gold', 'scrap', 'essence', 'wood', 'stone', 'shards']
    .filter((k) => cost?.[k])
    .map((k) => costChip(k, cost[k], resources[k] ?? 0));
}
