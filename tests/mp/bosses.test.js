// Every boss attack from single player, on the server: telegraphs, shots,
// areas and summons happen, hit the players standing in them, and nothing
// throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testServer, sleep } from './helpers.js';

test('every attack of every boss works in multiplayer', async () => {
  const t = await testServer({ worldSeed: 42 });
  const errors = [];
  try {
    t.gs.log.error = (...a) => errors.push(a.map(String).join(' '));
    const a = await t.bot('Bossjägaren');
    const p = t.player(a);
    let x = 120;
    while (!t.gs.world.isFree(x, 0.5, 3)) x += 1;
    t.place(a, x, 0.5);
    t.gs.config.maxEnemies = 0;
    const { spawnBoss } = await import('../../server/enemies.js');
    const { _test: { pattern } } = await import('../../server/bosses.js');
    for (const def of t.gs.data.bosses) {
      for (const e of t.gs.enemies.values()) e.dead = true;
      t.gs.areas.clear();
      t.gs.projectiles.clear();
      await sleep(80);
      // Back in the arena, alive (a weak boss: we only check that its attacks land).
      if (p.dead) p.dead = false;
      t.place(a, x, 0.5);
      p.hp = p.maxHp;
      p.statuses = {};
      const b = spawnBoss(t.gs, def.id, p.x + 4, p.y, null);
      b.hp = b.maxHp = 1e7;
      b.dmg = 0.5;
      b.patternCd = 99; // only the attacks we start
      let hurt = 0;
      for (const name of new Set(def.patterns)) {
        p.protectUntil = 0;
        p.hp = p.maxHp;
        const hp0 = p.hp;
        const cd = pattern(t.gs, b, p, name);
        assert.ok(cd > 0, `${def.id}/${name}: a pause before the next attack`);
        const seen = { areas: t.gs.areas.size, shots: t.gs.projectiles.size, enemies: t.gs.enemies.size };
        for (let i = 0; i < 25; i++) {
          // (Standing still, as a client does: idle inputs, so pulls and shoves move you.)
          for (let k = 0; k < 3; k++) a.input({});
          seen.areas = Math.max(seen.areas, t.gs.areas.size);
          seen.shots = Math.max(seen.shots, t.gs.projectiles.size);
          seen.enemies = Math.max(seen.enemies, t.gs.enemies.size);
          await sleep(100);
        }
        assert.ok(seen.areas + seen.shots + seen.enemies > 1 || b.x !== p.x + 4, `${def.id}/${name} did something`);
        if (p.hp < hp0) hurt++;
        b.state = 'move';
        b.submerged = false;
      }
      assert.ok(hurt > 0, `${def.id}: its attacks hurt a player who just stands there`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await t.close();
  }
});
