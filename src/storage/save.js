// Save game model: schema, defaults, migrations, validation, export/import.
// Pure functions + a small SaveManager that talks to a storage adapter.

import { hashString } from '../core/rng.js';
import { validateDna } from '../weapons/dna.js';

export const SAVE_SCHEMA = 1;
export const SAVE_KEY = 'save:main';
export const BACKUP_KEY = 'save:backup';
export const EXPORT_FORMAT = 'pixelgame-save';

export const DEFAULT_SETTINGS = Object.freeze({
  volume: 0.7,
  sfx: true,
  vibration: true,
  joystickSize: 1,
  joystickMode: 'dynamic', // 'dynamic' (appears under the thumb) | 'fixed'
  sprintMode: 'toggle', // 'toggle' | 'hold'
  leftHanded: false,
  quality: 'auto', // 'auto' | 'high' | 'low'
  screenShake: true,
  damageNumbers: true,
  showFps: false,
});

export class NewerSaveError extends Error {
  constructor(schema) {
    super(`This save was made by a newer version of the game (save format ${schema}). Update the app to load it.`);
    this.schema = schema;
  }
}

export function createNewSave({ worldSeed, now = Date.now(), appVersion = '0.0.0' }) {
  return {
    schema: SAVE_SCHEMA,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    appVersion,
    worldSeed: worldSeed >>> 0,
    player: { level: 1, xp: 0, hp: null, x: 0.5, y: 0.5, spawnX: 0.5, spawnY: 0.5, kills: 0, deaths: 0, playTime: 0 },
    inventory: { equipped: null, bag: [], storage: [], bagSize: 24, storageSize: 120 },
    codex: { weapons: {}, modifiers: [], effects: [], abilities: [] },
    resources: { scrap: 0, essence: 0 },
    components: {},
    bosses: { defeated: {} },
    world: { chests: [], shrines: [] },
    abilityState: { cooldowns: {} },
    counters: { drop: 0, craft: 0 },
    settings: { ...DEFAULT_SETTINGS },
    flags: { tutorialSeen: false, craftingAnnounced: false },
    sync: { lastSyncedRev: 0, accountId: null },
  };
}

/**
 * Migrations keyed by the schema version they upgrade *from*. Each takes a
 * save at version N and returns it at version N + 1. Add one whenever the
 * save format changes in a way `fillDefaults` can't handle (renames,
 * restructures), and bump SAVE_SCHEMA.
 */
export const MIGRATIONS = {};

export function migrateSave(save, migrations = MIGRATIONS, target = SAVE_SCHEMA) {
  if (!save || typeof save !== 'object') throw new Error('Save data is missing or corrupt');
  let current = Number.isInteger(save.schema) ? save.schema : 0;
  if (current > target) throw new NewerSaveError(current);
  const from = current;
  let out = save;
  while (current < target) {
    const step = migrations[current];
    if (!step) throw new Error(`No migration from save format ${current}`);
    out = step(structuredCloneSafe(out));
    current += 1;
    out.schema = current;
  }
  return { save: fillDefaults(out), migrated: from !== target, from };
}

function structuredCloneSafe(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Adds any fields missing from older/partial saves (additive changes). */
export function fillDefaults(save) {
  const def = createNewSave({ worldSeed: save.worldSeed ?? 1, now: save.createdAt ?? Date.now() });
  const out = { ...def, ...save };
  for (const key of ['player', 'inventory', 'codex', 'resources', 'bosses', 'world', 'abilityState', 'counters', 'flags', 'sync']) {
    out[key] = { ...def[key], ...(save[key] ?? {}) };
  }
  out.settings = { ...DEFAULT_SETTINGS, ...(save.settings ?? {}) };
  out.components = { ...(save.components ?? {}) };
  return out;
}

/** Structural validation; returns a list of problems (empty = ok). */
export function validateSave(save) {
  const p = [];
  if (!save || typeof save !== 'object') return ['not an object'];
  if (!Number.isInteger(save.worldSeed)) p.push('missing world seed');
  if (!save.player || !Number.isFinite(save.player.level)) p.push('missing player');
  if (!save.inventory || !Array.isArray(save.inventory.bag) || !Array.isArray(save.inventory.storage)) {
    p.push('missing inventory');
  } else {
    const ids = new Set();
    for (const w of [...save.inventory.bag, ...save.inventory.storage]) {
      const problems = validateDna(w);
      if (problems.length) p.push(`weapon ${w?.id ?? '?'}: ${problems[0]}`);
      if (ids.has(w?.id)) p.push(`duplicate weapon ${w.id}`);
      ids.add(w?.id);
    }
    if (save.inventory.equipped && !ids.has(save.inventory.equipped)) p.push('equipped weapon is missing');
  }
  if (!save.resources || !Number.isFinite(save.resources.scrap) || !Number.isFinite(save.resources.essence)) {
    p.push('missing resources');
  }
  return p;
}

// --- Export / import -----------------------------------------------------------

export function checksumOf(save) {
  return hashString(JSON.stringify(save)).toString(16).padStart(8, '0');
}

export function exportSave(save, now = Date.now()) {
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: now, checksum: checksumOf(save), save }, null, 1);
}

/**
 * Parses an exported save file. Verifies format + checksum, migrates and
 * validates. Throws an Error with a player-readable message on failure.
 */
export function parseImport(text, migrations = MIGRATIONS) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('That file is not a Pixelgame save (invalid JSON).');
  }
  if (obj?.format !== EXPORT_FORMAT || !obj.save) throw new Error('That file is not a Pixelgame save.');
  if (obj.checksum !== checksumOf(obj.save)) throw new Error('The save file is damaged or was edited (checksum mismatch).');
  const { save } = migrateSave(obj.save, migrations);
  const problems = validateSave(save);
  if (problems.length) throw new Error(`The save file is invalid: ${problems[0]}`);
  return save;
}

// --- Manager ---------------------------------------------------------------------

/**
 * Owns the persisted copy of the save. Writes are serialised (no two
 * overlapping writes), versioned (rev), and a backup of the previous save
 * is kept before migrations and imports.
 */
export class SaveManager {
  constructor(storage, { appVersion = '0.0.0', migrations = MIGRATIONS } = {}) {
    this.storage = storage;
    this.appVersion = appVersion;
    this.migrations = migrations;
    this.readOnly = false;
    this.readOnlyReason = null;
    this.chain = Promise.resolve();
    this.lastWrite = 0;
  }

  /** Loads (and migrates) the save, or returns null if there is none. */
  async load() {
    const raw = await this.storage.get(SAVE_KEY);
    if (!raw) return null;
    try {
      const { save, migrated } = migrateSave(raw, this.migrations);
      if (migrated) {
        await this.storage.set(BACKUP_KEY, raw);
        await this.storage.set(SAVE_KEY, save);
      }
      return save;
    } catch (err) {
      if (err instanceof NewerSaveError) {
        // Never overwrite a save we don't understand; play read-only until updated.
        this.readOnly = true;
        this.readOnlyReason = err.message;
      }
      throw err;
    }
  }

  /** Persists `save` (mutates rev/updatedAt). Resolves after commit. */
  write(save) {
    if (this.readOnly) return Promise.resolve(false);
    const job = this.chain.then(async () => {
      save.rev = (save.rev ?? 0) + 1;
      save.updatedAt = Date.now();
      save.appVersion = this.appVersion;
      save.schema = SAVE_SCHEMA;
      await this.storage.set(SAVE_KEY, save);
      this.lastWrite = save.updatedAt;
      return true;
    });
    this.chain = job.catch(() => {});
    return job;
  }

  async replace(save) {
    const current = await this.storage.get(SAVE_KEY);
    if (current) await this.storage.set(BACKUP_KEY, current);
    return this.write(save);
  }

  async loadBackup() {
    return (await this.storage.get(BACKUP_KEY)) ?? null;
  }
}
