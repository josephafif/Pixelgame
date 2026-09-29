// Human readable views of weapon DNA for the UI (discovery card, inventory,
// tooltips). Works from the DNA alone, with game data only used for nicer
// names when available.

const PROJECTILE_NAMES = {
  arrow: 'Arrow', bolt: 'Bolt', bullet: 'Bullet', ball: 'Cannonball', spark: 'Spark', orb: 'Orb',
  boomerang: 'Returning', chakram: 'Returning disc', globe: 'Orb', knife: 'Knife', wisp: 'Wisp',
  leafblade: 'Wind blade',
};

const PATTERN_NAMES = {
  swing: 'Swing', thrust: 'Thrust', slam: 'Slam', lash: 'Lash', shoot: 'Shot', lob: 'Lobbed shot',
  boomerang: 'Throw & return', volley: 'Volley', wisp: 'Homing wisps', cone: 'Cone',
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function elementName(data, id) {
  return data?.byId?.elements.get(id)?.name ?? cap(id);
}

export function archetypeName(data, id) {
  return data?.byId?.archetypes.get(id)?.name ?? cap(id);
}

export function rarityInfo(data, id) {
  const r = data?.byId?.rarities.get(id);
  return { name: r?.name ?? cap(id), color: r?.color ?? '#ccc' };
}

export function projectileLabel(dna) {
  const s = dna.stats;
  if (!s.projectiles) return 'None';
  const name = PROJECTILE_NAMES[dna.attack.projectile] ?? 'Projectile';
  return s.projectiles > 1 ? `${name} ×${s.projectiles}` : name;
}

/** Stat rows in the order the spec lists them. */
export function statRows(data, dna) {
  const s = dna.stats;
  const rows = [
    ['Damage', String(s.damage)],
    ['Attack Speed', s.attackSpeed.toFixed(2)],
    ['Range', s.range.toFixed(1)],
    ['Critical Chance', `${s.critChance}%`],
    ['Critical Damage', `${s.critDamage}%`],
    ['Projectile', projectileLabel(dna)],
    ['Element', elementName(data, dna.element)],
    ['Attack', PATTERN_NAMES[dna.attack.pattern] ?? cap(dna.attack.pattern)],
  ];
  if (s.pierce && s.pierce < 99) rows.push(['Pierce', String(s.pierce)]);
  if (s.homing) rows.push(['Homing', 'Yes']);
  if (s.split) rows.push(['Split', `×${s.split}`]);
  return rows;
}

export function abilityRows(ability) {
  if (!ability) return [];
  const rows = [['Cooldown', `${ability.cooldown}s`]];
  if (ability.damage) rows.push(['Damage', `${ability.damage}%`]);
  if (ability.radius) rows.push(['Area', ability.radius.toFixed(1)]);
  if (ability.duration) rows.push(['Duration', `${ability.duration}s`]);
  if (ability.count) rows.push(['Count', String(ability.count)]);
  if (ability.range) rows.push(['Range', ability.range.toFixed(1)]);
  if (ability.slow) rows.push(['Slow', `${ability.slow}%`]);
  return rows;
}

/** One-line summary, e.g. "Legendary Fire Sword". */
export function summaryLine(data, dna) {
  const el = dna.element === 'physical' ? '' : `${elementName(data, dna.element)} `;
  return `${rarityInfo(data, dna.rarity).name} ${el}${archetypeName(data, dna.archetype)}`;
}

/** Rough damage-per-second figure used for inventory comparisons. */
export function dpsEstimate(dna) {
  const s = dna.stats;
  const crit = 1 + (s.critChance / 100) * (s.critDamage / 100 - 1);
  return Math.round(s.damage * s.attackSpeed * crit * Math.max(1, s.projectiles || 1));
}
