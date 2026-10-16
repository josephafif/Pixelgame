// Weapon Evolution in single player: the Weapon Tree panel (U, the bag's
// Evolve button, the forge's tab), taking steps, tempering, and the grown
// weapon kept after a reload.

import { test, expect } from '@playwright/test';
import { startGame, trackErrors, game } from './helpers.js';

/** Forge 5, everything found but the Titan's blade, a boss beaten, plenty to spend. */
async function richPlayer(page) {
  await game(page, () => {
    const { game: g, data } = window.__pixelgame;
    const s = g.save;
    s.player.level = 30;
    s.base.buildings.forge = 5;
    for (const c of data.components) s.components[c.id] = { found: 1, researched: true };
    delete s.components.ancient_blade;
    s.bosses.defeated[data.bosses[0].id] = 1;
    Object.assign(s.resources, { scrap: 20000, essence: 20000, wood: 2000, stone: 2000, shards: 9, prismite: 300, spores: 300, aether: 300 });
  });
}

test('weapon tree: grow the starter sword step by step, temper it, keep it after a reload', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await richPlayer(page);
  const id = await game(page, () => window.__pixelgame.game.save.inventory.equipped);

  // U opens the tree of the weapon in hand.
  await page.keyboard.press('KeyU');
  const panel = page.locator('.evolution-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.evo-col')).toHaveCount(5);
  await expect(panel.locator('.evo-node.s-next')).toHaveCount(1);
  await expect(panel.locator('.evo-node', { hasText: 'Awakening' })).toHaveClass(/s-hidden/);

  // Further ahead, what you haven't found stays a secret: only where to look is told.
  await panel.locator('.evo-node', { hasText: 'Titan' }).click();
  await expect(panel.locator('.evo-reqs')).toContainText('An unknown find');
  await expect(panel.locator('.evo-reqs')).toContainText('Found in');
  // Step 1: Tempered.
  await panel.locator('.evo-node', { hasText: 'Tempered' }).click();
  await panel.locator('.evo-go').click();
  await expect(panel.locator('.evo-node', { hasText: 'Tempered' })).toHaveClass(/s-owned/);
  // As the next step, the Titan names the blade it needs, and waits for it.
  await panel.locator('.evo-node', { hasText: 'Titan' }).click();
  await expect(panel.locator('.evo-reqs')).toContainText('Ancient Blade');
  await expect(panel.locator('.evo-go')).toBeDisabled();
  // The Shadow form: a new weapon type, the other branches close.
  await panel.locator('.evo-node', { hasText: 'Shadow' }).click();
  await expect(panel.locator('.evo-detail')).toContainText('Dagger');
  await panel.locator('.evo-go').click();
  await expect(panel.locator('.evo-node', { hasText: 'Reaper' })).toHaveClass(/s-closed/);
  let w = await game(page, (id) => window.__pixelgame.game.findWeapon(id), id);
  expect(w.archetype).toBe('dagger');
  expect(w.rarity).toBe('rare');
  expect(await game(page, (id) => window.__pixelgame.game.weapon.dna.archetype, id)).toBe('dagger');

  // Masterwork, an element, and the awakening it opens.
  await panel.locator('.evo-go').click();
  await expect(panel.locator('.evo-node', { hasText: 'Thousand Cuts' })).toHaveClass(/s-owned/);
  await panel.locator('.evo-node', { hasText: 'Fire Infusion' }).click();
  await panel.locator('.evo-go').click();
  await expect(panel.locator('.evo-node.s-hidden')).toHaveCount(0);
  w = await game(page, (id) => window.__pixelgame.game.findWeapon(id), id);
  expect(w.rarity).toBe('epic');
  expect(w.element).toBe('fire');
  await panel.locator('.evo-node.s-next').first().click();
  await panel.locator('.evo-go').click();
  w = await game(page, (id) => window.__pixelgame.game.findWeapon(id), id);
  expect(w.rarity).toBe('legendary');
  expect(w.signature).toBeTruthy();
  expect(w.name.text).toMatch(/^(The )?Awakened/);
  await expect(panel.locator('.evo-title')).toContainText('LEGENDARY');

  // Tempering: up to your level.
  await game(page, () => { window.__pixelgame.game.save.player.level = 60; });
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyU');
  await panel.locator('.evo-temper button').click();
  w = await game(page, (id) => window.__pixelgame.game.findWeapon(id), id);
  expect(w.ctx.lvl).toBe(60);
  await expect(panel.locator('.evo-temper')).toContainText('Level 60');

  // Kept after a reload.
  await page.keyboard.press('Escape');
  await game(page, () => window.__pixelgame.game.saveNow());
  await page.reload();
  await page.click('#title-play');
  await expect.poll(() => game(page, (id) => window.__pixelgame?.game?.findWeapon(id)?.evo?.tier ?? null, id)).toBe(5);
  expect(await game(page, (id) => window.__pixelgame.game.findWeapon(id).ctx.lvl, id)).toBe(60);
  expect(errors).toEqual([]);
});

test('weapon tree: opens from the bag and the forge; grown weapons are safe from quick salvage', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await richPlayer(page);
  const id = await game(page, () => {
    const g = window.__pixelgame.game;
    const id = g.save.inventory.equipped;
    g.evolve(id, 'tempered');
    return id;
  });
  // The bag: an Evolve button on the weapon.
  await page.keyboard.press('KeyI');
  await page.locator('.inv-detail .evo-open').click();
  await expect(page.locator('.evolution-panel')).toBeVisible();
  await expect(page.locator('.evolution-panel .evo-node', { hasText: 'Tempered' })).toHaveClass(/s-owned/);
  // The forge: an Evolve tab.
  await page.keyboard.press('Escape');
  await page.keyboard.press('KeyC');
  await page.locator('.forge-panel .tab', { hasText: 'Evolve' }).click();
  await expect(page.locator('.evolution-panel')).toBeVisible();
  // Quick salvage never takes a grown weapon (it's in no loadout here).
  await game(page, (id) => {
    const g = window.__pixelgame.game;
    const inv = g.save.inventory;
    inv.equipped = null;
    g.salvageMany([id]);
  }, id);
  expect(await game(page, (id) => Boolean(window.__pixelgame.game.findWeapon(id)), id)).toBe(true);
  expect(errors).toEqual([]);
});
