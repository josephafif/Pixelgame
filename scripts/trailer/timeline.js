// The trailer's running order, in bars of music. The director (in the page)
// films a scene per entry; the soundtrack (music.mjs) is written to the
// same bars, so every cut, title and hit lands on the beat.

export const BPM = 120;
export const BEATS = 4; // per bar
export const BAR = (60 / BPM) * BEATS; // seconds
export const FPS = 60;

/**
 * Every shot, in order.
 *   id      — the scene (director.js)
 *   bars    — how long it runs
 *   label   — a small place or power name, lower left
 *   kind    — how the label looks: 'place' (default), 'power', 'boss'
 *   section — the music's part (music.mjs)
 */
export const SHOTS = [
  { id: 'aerial', bars: 4, section: 'intro' },
  { id: 'logo', bars: 2, section: 'logo' },

  { id: 'plains', bars: 1, label: 'Green Plains', section: 'explore' },
  { id: 'forest', bars: 1, label: 'Deepwood', section: 'explore' },
  { id: 'desert', bars: 1, label: 'Sunscar Desert', section: 'explore' },
  { id: 'snow', bars: 1, label: 'Frostvale', section: 'explore' },
  { id: 'ashlands', bars: 1, label: 'Ashlands', section: 'explore' },
  { id: 'void', bars: 1, label: 'Voidreach', section: 'explore' },
  { id: 'sail', bars: 2, label: 'The Sunken Isles', section: 'explore' },
  { id: 'ride', bars: 2, section: 'explore' },

  { id: 'prism', bars: 1.5, label: 'Prism Barrens', section: 'far' },
  { id: 'fen', bars: 1.25, label: 'Mireglass Fen', section: 'far' },
  { id: 'skyreach', bars: 1.25, label: 'Skyreach', section: 'far' },
  { id: 'village', bars: 1, label: 'Villages', section: 'far' },
  { id: 'market', bars: 1, label: 'Fortified markets', section: 'far' },
  { id: 'ruins', bars: 1, label: 'Ancient ruins', section: 'far' },

  { id: 'chest', bars: 3, section: 'weapons' },
  { id: 'gallery', bars: 2, section: 'weapons' },
  { id: 'evolve', bars: 3, section: 'rise' },

  { id: 'starfall', bars: 1, label: 'Starfall', kind: 'power', section: 'drop' },
  { id: 'breath', bars: 1, label: "Dragon's Breath", kind: 'power', section: 'drop' },
  { id: 'zero', bars: 1, label: 'Absolute Zero', kind: 'power', section: 'drop' },
  { id: 'storms', bars: 1, label: 'Wrath of Storms', kind: 'power', section: 'drop' },
  { id: 'horizon', bars: 1, label: 'Event Horizon', kind: 'power', section: 'drop' },
  { id: 'blades', bars: 1, label: 'Thousand Blades', kind: 'power', section: 'drop' },

  { id: 'boss:inferno_titan', bars: 1, label: 'Inferno Titan', kind: 'boss', section: 'drop' },
  { id: 'boss:frost_warden', bars: 1, label: 'Frost Warden', kind: 'boss', section: 'drop' },
  { id: 'boss:storm_colossus', bars: 1, label: 'Storm Colossus', kind: 'boss', section: 'drop' },
  { id: 'boss:prism_warden', bars: 1, label: 'The Prism Warden', kind: 'boss', section: 'drop' },
  { id: 'boss:aether_roc', bars: 1, label: 'The Aether Roc', kind: 'boss', section: 'drop' },
  { id: 'boss:tide_leviathan', bars: 1, label: 'Tide Leviathan', kind: 'boss', section: 'drop' },

  { id: 'build', bars: 2, section: 'build' },
  { id: 'defend', bars: 2, section: 'defend' },
  { id: 'friends', bars: 2, section: 'defend' },

  { id: 'montage', bars: 2, section: 'montage' },
  { id: 'end', bars: 4, section: 'end' },
];

/**
 * The big titles, by bar (they can span several shots).
 *   at, bars — when, and for how long
 *   text, sub — the title and a line under it
 */
export const TITLES = [
  { at: 6, bars: 2, text: 'Explore an endless world', sub: 'Every world is new: eleven lands, each with its own monsters' },
  { at: 12, bars: 2, text: 'Sail the open sea', sub: 'Build a boat. Find islands, wrecks and buried treasure' },
  { at: 14, bars: 2, text: 'Tame wild horses', sub: 'Gallop over hill and forest, leap from isle to isle' },
  { at: 16, bars: 4, text: 'Journey to the far lands', sub: 'Mirror deserts, glowing swamps and islands in the sky' },
  { at: 20, bars: 3, text: 'Discover the world', sub: 'Villages, markets, ruins, watchtowers and old maps' },
  { at: 23, bars: 3, text: 'Every weapon is one of a kind', sub: 'Each one grown from its own Weapon DNA' },
  { at: 26, bars: 2, text: 'Billions of weapons', sub: 'Swords, bows, scythes, wands, chakrams and more' },
  { at: 28, bars: 3, text: 'Grow it into a legend', sub: 'Evolve your weapon step by step, then awaken it' },
  { at: 31, bars: 2, text: 'Unleash legendary powers' },
  { at: 37, bars: 2, text: 'Face colossal bosses' },
  { at: 43, bars: 2, text: 'Build your stronghold', sub: 'Raise walls and turrets, hire workers, hatch pals' },
  { at: 45, bars: 2, text: 'Hold the night', sub: 'Monsters shun the light of your fires' },
  { at: 47, bars: 2, text: 'Play with friends', sub: 'Clans, bases and raids on your own server' },
];

/** Where each shot starts and ends, in seconds. */
export function schedule() {
  let bar = 0;
  return SHOTS.map((s, index) => {
    const out = { ...s, index, bar, start: bar * BAR, end: (bar + s.bars) * BAR, dur: s.bars * BAR };
    bar += s.bars;
    return out;
  });
}

export const TOTAL_BARS = SHOTS.reduce((n, s) => n + s.bars, 0);
export const DURATION = TOTAL_BARS * BAR;
