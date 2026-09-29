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

test('inventory, research, forge and settings panels open', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page);
  await page.keyboard.press('KeyI');
  await expect(page.locator('.inventory-panel')).toBeVisible();
  await page.click('.tab:has-text("Character")');
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

  await page.keyboard.press('KeyC');
  await expect(page.locator('.forge-panel')).toBeVisible();
  await page.selectOption('.forge-grid label:nth-child(3) select', 'fire_core');
  await page.click('.forge .btn-primary');
  await expect(page.locator('.discovery')).toBeVisible();
  await expect(page.locator('.weapon-card .subtitle')).toContainText('Fire');
  await page.click('.discovery button:has-text("Keep in bag")');

  await page.keyboard.press('Escape');
  await page.click('.menu button:has-text("Settings")');
  await expect(page.locator('.settings-panel')).toContainText('Offline play');
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
