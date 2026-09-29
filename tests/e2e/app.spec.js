import { test, expect } from '@playwright/test';
import { trackErrors, startGame, game } from './helpers.js';

test('boots, discovers the starter weapon and plays with keyboard + mouse', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const weapon = await game(page, () => window.__pixelgame.game.weapon.dna);
  expect(weapon.rarity).toBe('common');
  await expect(page.locator('#hud-weapon')).toContainText(weapon.name.text);

  const before = await game(page, () => ({ ...window.__pixelgame.game.player }));
  await page.keyboard.down('KeyD');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(600);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyD');
  const after = await game(page, () => ({ ...window.__pixelgame.game.player }));
  expect(after.x).toBeGreaterThan(before.x + 1);

  await page.mouse.move(900, 300);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  expect(await game(page, () => window.__pixelgame.game.player.attackCount)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('weapons are generated in a Web Worker and drops open the discovery screen', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  expect(await game(page, () => window.__pixelgame.game.weapons.mode)).toBe('worker');
  await game(page, () => window.__pixelgame.game.debugDrop({ minRarity: 'legendary' }));
  await page.keyboard.down('KeyD');
  await expect(page.locator('.discovery')).toBeVisible({ timeout: 5000 });
  await page.keyboard.up('KeyD');
  await expect(page.locator('.weapon-card .rarity')).toHaveText('LEGENDARY');
  await expect(page.locator('.weapon-card .ability-name')).toBeVisible();
  await page.click('.discovery .btn-primary');
  await expect(page.locator('#btn-ability')).toBeAttached();
  const cast = await game(page, () => {
    const g = window.__pixelgame.game;
    return g.weapon.dna.ability !== null;
  });
  expect(cast).toBe(true);
  expect(errors).toEqual([]);
});

test('inventory, research, camp, forge and settings panels open', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await page.keyboard.press('KeyI');
  await expect(page.locator('.inventory-panel')).toBeVisible();
  await page.click('.tab:has-text("Hero")');
  await expect(page.locator('.character')).toContainText('Critical Chance');
  await page.click('.tab:has-text("Codex")');
  await expect(page.locator('.codex')).toContainText('1 weapons discovered');
  await page.keyboard.press('Escape');

  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.player.level = 5;
    g.save.resources.essence = 500;
    g.save.resources.scrap = 200;
    g.discoverComponent('fire_core');
  });
  await page.keyboard.press('KeyR');
  await expect(page.locator('.research-panel')).toContainText('Fire Core');
  await page.click('.research-item .btn-primary');
  await expect(page.locator('.research-item .badge')).toHaveText('Researched');
  await page.keyboard.press('Escape');

  // No Forge yet: C opens the camp with the Forge highlighted.
  await page.keyboard.press('KeyC');
  await expect(page.locator('.base-panel')).toBeVisible();
  const forgeCard = page.locator('.bcard[data-building="forge"]');
  await expect(forgeCard).toHaveClass(/focus/);
  await forgeCard.locator('button:has-text("Build")').click();
  await expect(forgeCard).toContainText('Level 1');
  await expect(forgeCard.locator('button:has-text("Craft")')).toBeVisible();
  await forgeCard.locator('button:has-text("Craft")').click();

  await expect(page.locator('.forge-panel')).toBeVisible();
  await page.click('.forge .tile:has-text("Sword")');
  await page.click('.forge .chip:has-text("Fire Core")');
  await expect(page.locator('.forge-preview .result')).toContainText('Fire Sword');
  await page.click('.forge-preview .btn-primary');
  await expect(page.locator('.discovery')).toBeVisible();
  await expect(page.locator('.weapon-card .subtitle')).toContainText('Fire');
  await page.click('.discovery button:has-text("Keep in bag")');

  await page.keyboard.press('Escape');
  await page.click('.menu button:has-text("Settings")');
  await expect(page.locator('.settings-panel')).toContainText('Offline play');
  expect(errors).toEqual([]);
});

test('inventory: keyboard navigation, favorites, filters and quick salvage', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, async () => {
    const g = window.__pixelgame.game;
    for (let i = 0; i < 4; i++) {
      const dna = await g.weapons.generate({ seed: 500 + i, level: 3, luck: 0, source: 'drop', unlocked: [], maxRarity: 'uncommon' });
      g.save.inventory.bag.push(dna);
      g.save.inventory.unseen.push(dna.id);
    }
  });
  await page.keyboard.press('KeyI');
  await expect(page.locator('.inv-grid .slot:not(.empty)')).toHaveCount(5);
  await expect(page.locator('.slot .badge-new')).toHaveCount(4);
  // The equipped weapon leads and starts selected.
  await expect(page.locator('.slot.selected .badge-e')).toBeVisible();
  const equippedName = await page.locator('.inv-detail .weapon-name').textContent();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.inv-detail .weapon-name')).not.toHaveText(equippedName);
  await expect(page.locator('.slot .badge-new')).toHaveCount(3); // seen now
  const picked = await page.locator('.inv-detail .weapon-name').textContent();

  await page.keyboard.press('KeyF');
  await expect(page.locator('.slot.selected .badge-fav')).toBeVisible();
  await page.click('.inv-toolbar .chip:has-text("★")');
  await expect(page.locator('.inv-grid .slot:not(.empty)')).toHaveCount(1);
  await page.click('.inv-toolbar .chip:has-text("All")');

  // Quick salvage keeps the equipped weapon and favorites.
  await page.click('.inv-count .chip:has-text("Quick salvage")');
  page.once('dialog', (d) => d.accept());
  await page.click('.bulk button:has-text("Uncommon and below")');
  await expect(page.locator('.inv-grid .slot:not(.empty)')).toHaveCount(2);
  const left = await game(page, () => window.__pixelgame.game.save.inventory.bag.map((w) => w.name.text));
  expect(left).toContain(equippedName);
  expect(left).toContain(picked);

  // Q/E switch tabs.
  await page.keyboard.press('KeyE');
  await expect(page.locator('.tab.active')).toContainText('Storage');
  await page.keyboard.press('KeyQ');
  await expect(page.locator('.tab.active')).toContainText('Bag');
  await page.keyboard.press('Escape');
  // Keys pressed in the panel don't leak into the game afterwards.
  expect(await game(page, () => window.__pixelgame.game.input.commands.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('camp: buildings upgrade, the well pays out and the waystone recalls', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.player.level = 10;
    g.save.resources.essence = 2000;
    g.save.resources.scrap = 2000;
  });
  await expect(page.locator('#btn-base')).toHaveClass(/alert/);
  await page.keyboard.press('KeyB');
  await expect(page.locator('.base-panel')).toBeVisible();
  const hpBefore = await game(page, () => window.__pixelgame.game.pstats.maxHp);
  await page.click('.bcard[data-building="hearth"] button:has-text("Upgrade")');
  await expect(page.locator('.bcard[data-building="hearth"]')).toContainText('Level 2');
  expect(await game(page, () => window.__pixelgame.game.pstats.maxHp)).toBeGreaterThan(hpBefore);

  await page.click('.bcard[data-building="well"] button:has-text("Build")');
  await game(page, () => {
    window.__pixelgame.game.save.base.wellAt = Date.now() - 2 * 3600 * 1000;
    window.__pixelgame.game.emit('base');
  });
  const essence = await game(page, () => window.__pixelgame.game.save.resources.essence);
  await page.click('.bcard[data-building="well"] button:has-text("Collect")');
  expect(await game(page, () => window.__pixelgame.game.save.resources.essence)).toBe(essence + 16);

  await page.click('.bcard[data-building="waystone"] button:has-text("Build")');
  await page.keyboard.press('Escape');
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.player.x = 40;
    g.player.y = 40;
  });
  await page.keyboard.press('Escape');
  await page.click('.menu button:has-text("Recall to camp")');
  const pos = await game(page, () => ({ x: window.__pixelgame.game.player.x, y: window.__pixelgame.game.player.y }));
  expect(Math.hypot(pos.x, pos.y)).toBeLessThan(8);
  expect(errors).toEqual([]);
});

test('auto-aim: the weapon turns to the nearest enemy by itself', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  const aimed = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.player.x = 60;
    g.player.y = 60;
    g.enemies.length = 0;
    const { spawnEnemy } = await import('/src/game/enemies.js');
    const e = spawnEnemy(g, 'slime', 60, 57);
    await new Promise((r) => setTimeout(r, 300));
    return { locked: g.target === e, facing: g.player.facing };
  });
  expect(aimed.locked).toBe(true);
  // Enemy straight "up" (negative y) → facing ≈ -π/2.
  expect(Math.abs(Math.sin(aimed.facing) + 1)).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});

test('progress is saved to IndexedDB and restored after a reload', async ({ page }) => {
  await startGame(page);
  const id = await game(page, async () => {
    const g = window.__pixelgame.game;
    g.save.resources.essence = 321;
    await g.saveNow();
    return g.weapon.dna.id;
  });
  await page.reload();
  await expect(page.locator('#title-play')).toHaveText('Continue');
  const restored = await game(page, () => {
    const g = window.__pixelgame.game;
    return { essence: g.save.resources.essence, weapon: g.weapon?.dna.id, storage: window.__pixelgame.app.storage.kind };
  });
  expect(restored).toEqual({ essence: 321, weapon: id, storage: 'indexeddb' });
});

test('save export produces a valid file that imports back', async ({ page }) => {
  await startGame(page);
  const text = await game(page, async () => {
    const { exportSave, parseImport } = await import('/src/storage/save.js');
    const s = exportSave(window.__pixelgame.game.save);
    parseImport(s);
    return s;
  });
  expect(JSON.parse(text).format).toBe('pixelgame-save');
});
