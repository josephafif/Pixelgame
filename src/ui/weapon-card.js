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

export function weaponCard(data, dna, { compareTo = null, compact = false } = {}) {
  const rarity = rarityInfo(data, dna.rarity);
  const rows = statRows(data, dna);
  const dps = dpsEstimate(dna);
  const cmp = compareTo && compareTo.id !== dna.id ? dps - dpsEstimate(compareTo) : null;

  const statTable = h('dl.stats', rows.map(([k, v]) => [h('dt', k), h('dd', v)]));
  const mods = dna.modifiers.map((m) => h('li', { class: `mod mod-${m.category}` }, m.label));
  if (dna.drawback) mods.push(h('li.mod.mod-drawback', `${dna.drawback.name}: ${dna.drawback.label}`));
  const effects = dna.effects.map((e) => h('li.effect', h('b', e.name), ' — ', e.desc));
  const ab = dna.ability;

  return h('article.weapon-card', { style: { '--rarity': rarity.color } },
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
        `Power ${dna.power.used}/${dna.power.budget}`)));
}
