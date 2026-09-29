// Weapon naming. Names are built from the weapon's identity: archetype
// (nouns, compound suffixes), element (roots, adjectives), theme/modifiers
// (theme words), rarity (which formats are allowed) and ability (extra
// roots). Deterministic for a given rng stream.

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

const MODIFIER_WORDS = {
  lifesteal: ['Blood', 'Thirst'],
  feast: ['Hunger', 'Blood'],
  chain: ['Storm', 'Arc'],
  explosion: ['Blast', 'Cinder'],
  execute: ['Doom', 'Grave'],
  homing: ['Seeker', 'Hawk'],
  split: ['Hydra', 'Swarm'],
  critc: ['Keen', 'Fate'],
  critd: ['Ruin', 'Fate'],
  momentum: ['Rush', 'Comet'],
};

/**
 * @param {object} data indexed game data
 * @param {object} parts { archetype, element, rarityIdx, theme, modifiers, ability }
 * @param {object} rng
 * @returns {{ text: string, format: string, words: string[] }}
 */
export function generateName(data, parts, rng) {
  const names = data.names;
  const { archetype, element, rarityIdx, theme, modifiers, ability } = parts;

  const roots = [...(names.elementRoots[element] ?? names.elementRoots.physical)];
  const adjectives = [...(names.elementAdjectives[element] ?? names.elementAdjectives.physical)];
  const themeWords = names.themeWords[theme?.id] ?? [];
  // Theme and modifier words let two fire swords with different builds get
  // differently flavoured names.
  for (const w of themeWords) {
    roots.push(w);
    adjectives.push(w);
  }
  for (const m of modifiers) {
    for (const w of MODIFIER_WORDS[m.id] ?? []) roots.push(w);
  }
  if (ability) {
    const tpl = data.byId.abilities.get(ability.id);
    for (const w of tpl?.words ?? []) roots.push(w, w);
  }

  const noun = rng.pick(archetype.nouns);
  const suffix = rng.pick(archetype.suffixes);
  const root = rng.pick(roots);
  const adj = rng.pick(adjectives);
  const format = rng.weighted(names.formats, (f) => f.weights[rarityIdx] ?? 0).id;

  let text;
  switch (format) {
    case 'adj_noun':
      text = `${adj} ${noun}`;
      break;
    case 'the_adj_noun':
      text = `The ${adj} ${noun}`;
      break;
    case 'root_noun':
      text = `${root} ${noun}`;
      break;
    case 'compound':
      text = `${capitalize(root)}${suffix}`;
      break;
    case 'celestial':
      text = `${root} ${rng.pick(names.celestial)}`;
      break;
    case 'title':
      text = `${root} ${rng.pick(names.titles)}'s ${noun}`;
      break;
    case 'compound_epithet':
      text = `${capitalize(root)}${suffix}, ${rng.pick(names.epithets)}`;
      break;
    default:
      text = `${adj} ${noun}`;
  }
  // Avoid stutters like "Iron Iron" or "Frost Frostbite".
  const parts2 = text.split(' ');
  if (parts2.length >= 2 && parts2[0].toLowerCase() === parts2[1].toLowerCase()) {
    text = `${adj} ${archetype.name}`;
  }
  return { text, format, words: [root, adj, noun, suffix] };
}
