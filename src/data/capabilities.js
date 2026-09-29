// What this client build knows how to execute. Game data (which can be
// updated without shipping a new client) may only reference these
// primitives; entries that reference anything else are skipped so that a
// newer data file degrades gracefully on an older client.

export const SUPPORTED_SCHEMA = 1;

export const ATTACK_PATTERNS = new Set([
  'swing', 'thrust', 'slam', 'lash', 'shoot', 'lob', 'boomerang', 'volley', 'wisp', 'cone',
]);

export const PROJECTILE_PATTERNS = new Set(['shoot', 'lob', 'boomerang', 'volley', 'wisp', 'cone']);

export const SPRITE_TEMPLATES = new Set([
  'blade', 'axe', 'hammer', 'mace', 'polearm', 'scythe', 'bow', 'crossbow', 'gun', 'cannon',
  'wand', 'staff', 'orb', 'boomerang', 'chakram', 'whip', 'knives', 'lantern', 'fan',
]);

export const HOOK_TRIGGERS = new Set(['attack', 'hit', 'crit', 'kill', 'nth', 'static']);

export const HOOK_ACTIONS = new Set([
  'elementDamage', 'heal', 'chain', 'explode', 'status', 'execute', 'sprintBonus', 'selfDamage',
  'projectile', 'projMod', 'portal', 'nova', 'cloud', 'echo', 'spin', 'spikes', 'strike', 'blink',
  'buff', 'shatter',
]);

export const ABILITY_ACTIONS = new Set([
  'meteor', 'blink', 'blackhole', 'clone', 'quake', 'phoenix', 'storm', 'frostnova', 'bladering', 'timewarp',
]);

export const WEAPON_STATS = new Set([
  'damagePct', 'attackSpeedPct', 'critChance', 'critDamage', 'projectileSpeedPct', 'rangePct',
  'projectiles', 'pierce', 'homing', 'knockback', 'split',
]);

export const PLAYER_STATS = new Set([
  'moveSpeedPct', 'defense', 'defensePct', 'luck', 'damageTakenPct',
]);
