import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATURE_KINDS, PAL_KINDS, frameMaps, hasCreature } from '../../src/render/creatures.js';
import { moveMode } from '../../src/game/enemies.js';
import { loadData } from './helpers.js';

const data = loadData();
const land = data.enemies.filter((e) => !e.sea);

function checkFrames(kind) {
  const def = frameMaps(kind);
  const pal = def.pal('#8a8a9a');
  const sets = ['walk', 'idle', 'attack', 'sleep'].map((k) => def[k]).filter(Boolean);
  const all = sets.flat();
  const h = all[0].length;
  const w = Math.max(...all[0].map((r) => r.length));
  for (const frame of all) {
    assert.equal(frame.length, h, `${kind}: every frame is as tall`);
    for (const row of frame) {
      assert.equal(row.length, w, `${kind}: every row is as wide (${row})`);
      for (const ch of row) if (ch !== '.') assert.ok(pal[ch], `${kind}: colour for '${ch}'`);
    }
  }
  return def;
}

test('every land monster is animated: several walk (or idle) frames, one size, full palette', () => {
  for (const e of land) {
    // (Faction troops share a look: legionary, marksman, warlord.)
    const look = e.look ?? e.id;
    assert.ok(hasCreature(look), `${e.id} has animated frames`);
    const def = checkFrames(look);
    const moving = def.walk ?? def.idle;
    assert.ok(moving.length >= 2, `${e.id} actually moves`);
  }
  assert.ok(CREATURE_KINDS.length >= 17);
});

test('each biome has its own monsters, so the world feels different everywhere', () => {
  const seen = new Map();
  for (const b of data.biomes) {
    assert.ok(b.enemies.length >= 3, `${b.id} has a varied roster`);
    for (const id of b.enemies) seen.set(id, [...(seen.get(id) ?? []), b.id]);
  }
  for (const b of data.biomes) {
    const own = b.enemies.filter((id) => seen.get(id).length === 1);
    assert.ok(own.length >= 1, `${b.id} has a monster found nowhere else`);
  }
});

test('new monsters bring new ways to fight: charges, packs, sidesteps, blinks, flyers', async () => {
  const behaviours = new Set(land.map((e) => e.behavior));
  for (const b of ['chase', 'swoop', 'ranged', 'caster', 'charger', 'pack', 'scuttle', 'blinker']) assert.ok(behaviours.has(b), b);
  const byId = (id) => data.byId.enemies.get(id);
  // Every charger winds up for a moment you can react to.
  for (const e of land.filter((d) => ['charger', 'pack', 'scuttle'].includes(d.behavior))) {
    assert.ok((e.windup ?? 0.6) >= 0.25, `${e.id} telegraphs its charge`);
  }
  assert.equal(moveMode({ def: byId('harpy'), kind: 'harpy' }), 'fly');
  assert.equal(moveMode({ def: byId('eye'), kind: 'eye' }), 'fly');
  assert.equal(moveMode({ def: byId('wolf'), kind: 'wolf' }), 'enemy');
  assert.deepEqual(byId('wolf').group, [2, 4], 'wolves hunt in packs');
});

test('pals have walk, idle, attack and nap frames', () => {
  assert.deepEqual([...PAL_KINDS].sort(), data.pals.species.map((s) => s.id).sort());
  for (const kind of PAL_KINDS) {
    const def = checkFrames(kind);
    assert.ok(def.walk.length >= 2 && def.idle.length >= 2 && def.attack.length && def.sleep.length, kind);
  }
});
