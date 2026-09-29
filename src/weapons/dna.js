// Weapon DNA: the serialisable description of a weapon. Gameplay reads DNA
// only; no weapon has hand-written logic. DNA is stored in full (not just
// the seed) so saved weapons never change when game data is updated.
// `seed` + `ctx` + `gen` + `data` are enough to regenerate the identical DNA
// on any compatible device.

export const DNA_VERSION = 1;
const CODE_PREFIX = 'PGW1.';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Structural validation (shape and types). Rule validation lives in
 * rules.auditWeapon. Returns a list of problems (empty = valid).
 */
export function validateDna(dna) {
  const p = [];
  if (!dna || typeof dna !== 'object') return ['not an object'];
  if (dna.v !== DNA_VERSION) p.push(`unsupported DNA version ${dna.v}`);
  for (const key of ['id', 'archetype', 'rarity', 'element', 'material', 'theme']) {
    if (!isStr(dna[key])) p.push(`missing ${key}`);
  }
  if (!Number.isInteger(dna.seed) || dna.seed < 0 || dna.seed > 0xffffffff) p.push('bad seed');
  if (!Number.isInteger(dna.gen)) p.push('bad gen');
  if (!dna.ctx || typeof dna.ctx !== 'object') p.push('missing ctx');
  if (!dna.name || !isStr(dna.name.text)) p.push('missing name');
  if (!dna.attack || !isStr(dna.attack.pattern)) p.push('missing attack');
  const s = dna.stats;
  if (!s) p.push('missing stats');
  else {
    for (const key of ['damage', 'attackSpeed', 'range', 'critChance', 'critDamage']) {
      if (!isNum(s[key]) || s[key] < 0) p.push(`bad stat ${key}`);
    }
    if (s.damage <= 0 || s.attackSpeed <= 0) p.push('non-positive damage or attack speed');
  }
  for (const listKey of ['modifiers', 'effects']) {
    if (!Array.isArray(dna[listKey])) p.push(`missing ${listKey}`);
    else for (const m of dna[listKey]) if (!isStr(m?.id)) p.push(`bad ${listKey} entry`);
  }
  if (dna.ability !== null && (typeof dna.ability !== 'object' || !isStr(dna.ability?.id))) p.push('bad ability');
  if (!dna.power || !isNum(dna.power.used) || !isNum(dna.power.budget)) p.push('missing power');
  if (!dna.visual || !isStr(dna.visual.template)) p.push('missing visual');
  return p;
}

/** Deep clone into plain JSON (drops functions/undefined). */
export function serializeDna(dna) {
  return JSON.parse(JSON.stringify(dna));
}

function toBase64Url(str) {
  const b64 = typeof btoa === 'function' ? btoa(str) : Buffer.from(str, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice((b64.length + 3) % 4);
  return typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
}

/**
 * Short shareable code containing only the generation inputs. Another
 * device with the same generator + data version rebuilds the exact weapon.
 */
export function encodeDnaCode(dna) {
  const payload = JSON.stringify({ s: dna.seed, g: dna.gen, d: dna.data, c: dna.ctx });
  return CODE_PREFIX + toBase64Url(payload);
}

export function decodeDnaCode(code) {
  if (typeof code !== 'string' || !code.startsWith(CODE_PREFIX)) throw new Error('Not a weapon code');
  const obj = JSON.parse(fromBase64Url(code.slice(CODE_PREFIX.length)));
  if (!Number.isInteger(obj.s) || !obj.c) throw new Error('Corrupt weapon code');
  return { seed: obj.s >>> 0, gen: obj.g, data: obj.d, ctx: obj.c };
}
