// The upkeep box shown in the Vault (single player) and the clan vault
// (multiplayer): what the base costs per day and what causes it, and how
// long the supplies in the vault keep the base running.

import { h } from './dom.js';
import { icon, costChips } from './icons.js';
import { suppliesLast, firstToRunOut, formatHours, roundUp } from '../game/upkeep.js';

const TEXT = {
  en: {
    title: 'Upkeep per day',
    structures: (n) => `Walls and other structures (${n})`,
    buildings: (n) => `Camp buildings (${n} levels)`,
    workers: (n) => `Workers' wages (${n})`,
    total: 'In all',
    none: 'Nothing to pay yet.',
    lasts: 'The supplies in the vault last',
    empty: (k) => `The vault has no ${k.toLowerCase()} left for the upkeep.`,
    runsOut: (k) => `${k} runs out first`,
    unpaid: 'Upkeep is not being paid! Workers have stopped and walls are crumbling. Put supplies in the vault.',
    hourly: 'Paid from the vault once an hour.',
  },
  sv: {
    title: 'Underhåll per dygn',
    structures: (n) => `Murar och andra byggen (${n})`,
    buildings: (n) => `Basens byggnader (${n} nivåer)`,
    workers: (n) => `Arbetarnas löner (${n})`,
    total: 'Totalt',
    none: 'Inget att betala än.',
    lasts: 'Förråden i valvet räcker i',
    empty: (k) => `Valvet har slut på ${k.toLowerCase()} till underhållet.`,
    runsOut: (k) => `${k} tar slut först`,
    unpaid: 'Underhållet betalas inte! Arbetarna har slutat och murarna förfaller. Lägg in förråd i valvet.',
    hourly: 'Dras ur valvet en gång i timmen.',
  },
};
const RES_SV = { wood: 'Trä', stone: 'Sten', scrap: 'Skrot', essence: 'Essens' };
const RES_EN = { wood: 'Wood', stone: 'Stone', scrap: 'Scrap', essence: 'Essence' };

/**
 * opts: { perDay: { structures, buildings, workers, total }, counts:
 * { structures, buildingLevels, workers }, vault, unpaid, lang, note }.
 */
export function upkeepBox({ perDay, counts, vault, unpaid = false, lang = 'en', note = null }) {
  const t = TEXT[lang] ?? TEXT.en;
  const names = lang === 'sv' ? RES_SV : RES_EN;
  const row = (label, part) => (Object.keys(roundUp(part)).length
    ? h('div.upkeep-row', h('span', label), h('span.upkeep-cost', costChips(roundUp(part))))
    : null);
  const total = roundUp(perDay.total);
  const hours = suppliesLast(vault, perDay.total);
  const first = firstToRunOut(vault, perDay.total);
  let lasting = null;
  if (Object.keys(total).length && hours <= 0) {
    lasting = h('div.upkeep-lasts.low', icon('chest', 20), h('b', t.empty(names[first] ?? first)));
  } else if (Object.keys(total).length) {
    lasting = h(`div.upkeep-lasts${hours < 24 ? '.low' : ''}`,
      icon('chest', 20),
      h('span', `${t.lasts} `, h('b', formatHours(hours, lang))),
      first && Number.isFinite(hours) ? h('span.small.muted', ` · ${t.runsOut(names[first] ?? first)}`) : null);
  }
  return h('section.upkeep-box',
    h('h3', t.title),
    unpaid ? h('p.warn.small', icon('skull', 16), ' ', t.unpaid) : null,
    Object.keys(total).length
      ? h('div.upkeep-rows',
        row(t.structures(counts.structures ?? 0), perDay.structures),
        row(t.buildings(counts.buildingLevels ?? 0), perDay.buildings),
        row(t.workers(counts.workers ?? 0), perDay.workers),
        h('div.upkeep-row.total', h('b', t.total), h('span.upkeep-cost', costChips(total, vault))))
      : h('p.small.muted', t.none),
    lasting,
    h('p.small.muted', note ?? t.hourly));
}
