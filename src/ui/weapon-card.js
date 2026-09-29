// Weapon card: the full readable view of a weapon's DNA.

import { h, pixelCanvas } from './dom.js';
import { weaponIcon } from '../render/weapon-sprite.js';
import { statRows, abilityRows, rarityInfo, summaryLine, dpsEstimate, elementName } from '../weapons/describe.js';
import { formatSeed } from '../core/rng.js';

export function weaponIconEl(dna, size = 48) {
  const el = pixelCanvas(weaponIcon(dna, 32), size);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function section(title, ...content) {
  return h('section.card-section', h('h4', title), ...content);
}

// Stat rows that can be compared numerically with the equipped weapon.
const COMPARABLE = {
  Damage: ['damage', 0],
  'Attack Speed': ['attackSpeed', 2],
  Range: ['range', 1],
  'Critical Chance': ['critChance', 0],
  'Critical Damage': ['critDamage', 0],
};

function statDelta(label, dna, other) {
  const spec = COMPARABLE[label];
  if (!spec || !other) return null;
  const [key, digits] = spec;
  const d = (dna.stats[key] ?? 0) - (other.stats[key] ?? 0);
  if (Math.abs(d) < 10 ** -digits / 2) return null;
  return h(`span.delta.${d > 0 ? 'up' : 'down'}`, `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}`);
}

export function weaponCard(data, dna, { compareTo = null, compact = false } = {}) {
  const rarity = rarityInfo(data, dna.rarity);
  const rows = statRows(data, dna);
  const dps = dpsEstimate(dna);
  const other = compareTo && compareTo.id !== dna.id ? compareTo : null;
  const cmp = other ? dps - dpsEstimate(other) : null;

  const statTable = h('dl.stats', rows.map(([k, v]) => [h('dt', k), h('dd', v, statDelta(k, dna, other))]));
  const mods = dna.modifiers.map((m) => h('li', { class: `mod mod-${m.category}` }, m.label));
  if (dna.drawback) mods.push(h('li.mod.mod-drawback', `${dna.drawback.name}: ${dna.drawback.label}`));
  const effects = dna.effects.map((e) => h('li.effect', h('b', e.name), ' — ', e.desc));
  const ab = dna.ability;

  return h(`article.weapon-card.r-${dna.rarity}`, { style: { '--rarity': rarity.color } },
    h('div.card-head',
      h('div.card-icon', weaponIconEl(dna, compact ? 56 : 80)),
      h('div.card-title',
        h('h3.weapon-name', dna.name.text),
        h('div.rarity', rarity.name.toUpperCase()),
        h('div.subtitle', summaryLine(data, dna)),
        h('div.identity', `Playstyle: ${dna.identity}`))),
    h('div.dps-row',
      h('span', `≈ ${dps} DPS`),
      cmp !== null ? h(`span.delta.${cmp >= 0 ? 'up' : 'down'}`, `${cmp >= 0 ? '▲' : '▼'} ${Math.abs(cmp)} vs equipped`) : null),
    statTable,
    mods.length ? section('Modifiers', h('ul.mods', mods)) : null,
    effects.length ? section('Special Effects', h('ul.effects', effects)) : null,
    ab ? section('Ability',
      h('div.ability-name', ab.name),
      h('p.ability-desc', ab.desc, ab.twistDesc ? ` ${ab.twistDesc}` : '', ab.infuse ? ` Infused with ${elementName(data, ab.infuse)}.` : ''),
      h('dl.stats.small', abilityRows(ab).map(([k, v]) => [h('dt', k), h('dd', v)]))) : null,
    compact ? null : h('div.dna-row',
      h('span.seed', `Weapon Seed: ${formatSeed(dna.seed)}`),
      h('span.power', { title: 'Power budget used by modifiers, effects and ability' },
        `Power ${dna.power.used}/${dna.power.budget}`,
        h('div.power-bar', h('div', { style: { width: `${Math.min(100, (100 * dna.power.used) / Math.max(1, dna.power.budget))}%` } })))));
}
