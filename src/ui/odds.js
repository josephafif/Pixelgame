// Loot odds: the real chance of each rarity per source, worked out from the
// same numbers the game rolls with (your level and luck included).

import { h } from './dom.js';
import { openModal } from './modal.js';
import { rarityOdds, WEAPON_DROP_CHANCE } from '../game/economy.js';

function pct(f) {
  if (f <= 0) return '–';
  const p = f * 100;
  if (p < 0.01) return '<0.01%';
  if (p < 1) return `${p.toFixed(2)}%`;
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

export function oddsRows(game) {
  const { data } = game;
  const level = game.save.player.level;
  const luck = Math.floor(game.pstats.luck);
  const drop = (label, source, minRarity, weapon) => ({
    label, weapon, odds: rarityOdds(data, { source, minRarity, level, luck }),
  });
  const rows = [
    drop('Monster', 'drop', null, WEAPON_DROP_CHANCE.drop),
    drop('Elite monster', 'elite', 'uncommon', WEAPON_DROP_CHANCE.elite),
    drop('Chest', 'chest', 'uncommon', WEAPON_DROP_CHANCE.chest),
    drop('Boss', 'boss', 'rare', WEAPON_DROP_CHANCE.boss),
  ];
  for (const c of data.catalysts) {
    rows.push({
      label: `Forge: ${c.name}`,
      weapon: null,
      forge: true,
      odds: rarityOdds(data, { minRarity: c.minRarity, maxRarity: c.maxRarity, level, luck, forge: true }),
    });
  }
  return rows;
}

export function open(game) {
  const { data } = game;
  const rows = oddsRows(game);
  // Short headers on phones so the whole table fits without scrolling.
  const both = (long, short) => [h('span.long', long), h('span.short', short)];
  const head = h('tr',
    h('th', 'Source'),
    h('th.num', { title: 'Chance that a weapon drops at all' }, both('Weapon', 'Drop')),
    data.rarities.map((r) => h('th.num', { style: { color: r.color }, title: r.name }, both(r.name, r.name.slice(0, 3)))));
  const body = rows.map((row) => h('tr', { class: row.forge ? 'forge-row' : null },
    h('th', both(row.label, row.label.replace('Forge: ', '').replace(' Catalyst', '').replace(' monster', ''))),
    h('td.num', row.weapon == null ? 'always' : pct(row.weapon)),
    data.rarities.map((r) => h('td.num', { style: { color: row.odds[r.id] > 0 ? r.color : null } }, pct(row.odds[r.id])))));
  const content = h('div.odds',
    h('p.small.muted',
      `The chance of each rarity when a weapon drops or is forged, for you right now (level ${game.save.player.level}, luck ${Math.floor(game.pstats.luck)}). `
      + 'Level and luck tilt the odds a little towards rarer weapons.'),
    h('div.odds-scroll', h('table.odds-table', h('thead', head), h('tbody', body))),
    h('p.small.muted', 'Epic and legendary weapons come from their own small roll; everything else is common to rare. '
      + 'Bosses always drop a weapon. Forge odds are before any boss-core bonus.'));
  openModal({ title: 'Loot odds', icon: 'star', body: content, className: 'wide odds-panel' });
}
