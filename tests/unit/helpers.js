import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepareGameData } from '../../src/data/gamedata.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

let cached = null;
export function loadData() {
  cached ??= prepareGameData(readJson('data/v1/gamedata.json'));
  return cached;
}

export function allComponentIds(data) {
  return data.components.map((c) => c.id);
}

/** Deterministic spread of seeds for sweeps. */
export function seeds(n, salt = 1) {
  return Array.from({ length: n }, (_, i) => (Math.imul(i + salt, 2654435761) >>> 0));
}
