// Player stats: Health, Movement Speed, Attack Power, Defense, Critical
// Chance, Critical Damage, Luck and elemental resistances. No stamina —
// sprinting is free and can be held forever.

import { baseBonuses } from './base.js';

export function xpToNext(data, level) {
  const { base, growth } = data.player.xp;
  return Math.round(base * growth ** (level - 1));
}

/**
 * @param {object} data game data
 * @param {object} save current save
 * @param {object|null} dna equipped weapon DNA
 * @param {Array<{stat: string, value: number}>} buffs temporary buffs
 */
export function computePlayerStats(data, save, dna, buffs = []) {
  const p = data.player;
  const L = save.player.level - 1;
  const bonus = dna?.playerBonuses ?? {};
  const camp = data.base ? baseBonuses(data, save) : { maxHpPct: 0, attackPower: 0, defense: 0 };
  const buffTotal = (stat) => buffs.reduce((sum, b) => sum + (b.stat === stat ? b.value : 0), 0);
  const resist = {};
  for (const el of data.elements) resist[el.id] = 0;
  if (dna && dna.element !== 'physical') resist[dna.element] = p.elementAttunement;
  for (const [el, v] of Object.entries(save.player.resist ?? {})) resist[el] = (resist[el] ?? 0) + v;
  return {
    maxHp: Math.round((p.health + p.perLevel.health * L) * (1 + camp.maxHpPct / 100)) + (save.player.bonusHp ?? 0),
    moveSpeed: p.moveSpeed * (1 + ((bonus.moveSpeedPct ?? 0) + buffTotal('moveSpeedPct')) / 100),
    attackPower: Math.round(p.attackPower + p.perLevel.attackPower * L + camp.attackPower + buffTotal('attackPower')),
    defense: Math.max(0, Math.round((p.defense + p.perLevel.defense * L + camp.defense + (bonus.defense ?? 0)) * (1 + (bonus.defensePct ?? 0) / 100))),
    critChance: Math.min(90, p.critChance + (dna?.stats.critChance ?? 0)),
    critDamage: Math.max(p.critDamage, dna?.stats.critDamage ?? 0),
    luck: Math.round((p.luck + p.perLevel.luck * L + (bonus.luck ?? 0) + (save.player.bonusLuck ?? 0)) * 10) / 10,
    resist,
    damageTaken: 1 + (bonus.damageTakenPct ?? 0) / 100,
    attackSpeedMult: 1 + buffTotal('attackSpeedPct') / 100,
  };
}

/** Rows for the character sheet. */
export function statSheet(data, stats) {
  const resist = Object.entries(stats.resist).filter(([, v]) => v > 0)
    .map(([el, v]) => `${data.byId.elements.get(el)?.name ?? el} ${v}%`).join(', ') || 'None';
  return [
    ['Health', String(stats.maxHp)],
    ['Movement Speed', stats.moveSpeed.toFixed(1)],
    ['Attack Power', `+${stats.attackPower}%`],
    ['Defense', String(stats.defense)],
    ['Critical Chance', `${stats.critChance}%`],
    ['Critical Damage', `${stats.critDamage}%`],
    ['Luck', String(stats.luck)],
    ['Elemental Resistance', resist],
  ];
}
