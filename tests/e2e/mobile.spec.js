import { test, expect } from '@playwright/test';
import { trackErrors, startGame, game } from './helpers.js';

async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

test('touch controls: joystick, sprint toggle and attack button', async ({ page, context }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  await expect(page.locator('#btn-attack')).toBeVisible();
  await expect(page.locator('#btn-sprint')).toBeVisible();
  await expect(page.locator('#btn-ability')).toBeHidden(); // starter weapon has no ability

  const cdp = await context.newCDPSession(page);
  const { height } = page.viewportSize();
  const start = await game(page, () => ({ ...window.__pixelgame.game.player }));
  await touch(cdp, 'touchStart', [{ x: 90, y: height - 150, id: 1 }]);
  for (let i = 1; i <= 8; i++) {
    await touch(cdp, 'touchMove', [{ x: 90 + i * 7, y: height - 150, id: 1 }]);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
  await touch(cdp, 'touchEnd', []);
  const moved = await game(page, () => ({ ...window.__pixelgame.game.player }));
  expect(moved.x).toBeGreaterThan(start.x + 1);

  await page.tap('#btn-sprint');
  await expect(page.locator('#btn-sprint')).toHaveAttribute('aria-pressed', 'true');

  const box = await page.locator('#btn-attack').boundingBox();
  await touch(cdp, 'touchStart', [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 2 }]);
  await page.waitForTimeout(1200);
  await touch(cdp, 'touchEnd', []);
  expect(await game(page, () => window.__pixelgame.game.player.attackCount)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('layout fits portrait and landscape without scrolling the page', async ({ page }) => {
  await startGame(page, { tap: true });
  for (const size of [{ width: 412, height: 839 }, { width: 839, height: 412 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(200);
    const fit = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      w: innerWidth,
      h: innerHeight,
      canvas: document.querySelector('#game').getBoundingClientRect().width,
    }));
    expect(fit.scrollW).toBeLessThanOrEqual(fit.w);
    expect(fit.scrollH).toBeLessThanOrEqual(fit.h);
    expect(fit.canvas).toBe(fit.w);
    const attack = await page.locator('#btn-attack').boundingBox();
    expect(attack.x + attack.width).toBeLessThanOrEqual(size.width);
    expect(attack.y + attack.height).toBeLessThanOrEqual(size.height);
  }
});

test('panels are full-screen and scrollable on phones', async ({ page }) => {
  await startGame(page, { tap: true });
  await page.tap('#btn-menu');
  await page.tap('.menu button:has-text("Inventory")');
  await expect(page.locator('.inventory-panel')).toBeVisible();
  // Layout width (boundingBox would include the opening scale animation).
  const width = await page.evaluate(() => document.querySelector('.inventory-panel').offsetWidth);
  expect(width).toBe(page.viewportSize().width);
  const scrollable = await page.evaluate(() => getComputedStyle(document.querySelector('.panel-body')).overflowY);
  expect(scrollable).toBe('auto');
});

test('phone HUD: player plate and dock never overlap; forge button stays reachable', async ({ page }) => {
  await startGame(page, { tap: true });
  for (const size of [{ width: 360, height: 740 }, { width: 412, height: 839 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    const plate = await page.locator('.hud-player').boundingBox();
    const dock = await page.locator('.dock').boundingBox();
    expect(plate.x + plate.width).toBeLessThanOrEqual(dock.x);
    expect(dock.x + dock.width).toBeLessThanOrEqual(size.width);
  }
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.base.buildings.forge = 1;
  });
  // Phones keep a slim dock: Forge, Research and Camp live in the menu.
  await expect(page.locator('#btn-forge')).toBeHidden();
  await expect(page.locator('#btn-map')).toBeVisible();
  await page.tap('#btn-menu');
  await page.tap('.menu button:has-text("Forge")');
  await expect(page.locator('.forge-panel')).toBeVisible();
  await page.tap('.forge-panel .tab:has-text("Weapons")');
  // The sticky bar keeps cost + Forge button on screen while picking.
  const bar = page.locator('.forge-bar .btn-primary');
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
});

test('build mode on a phone: tap the ground to place, the attack button becomes Place', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  await game(page, () => {
    const g = window.__pixelgame.game;
    Object.assign(g.save.resources, { wood: 100 });
    g.player.x = 5.5;
    g.player.y = 1.5;
    g.renderer.snapCamera();
  });
  await page.waitForTimeout(300);
  await page.tap('#btn-build');
  await expect(page.locator('#build-bar')).toBeVisible();
  await expect(page.locator('#btn-attack')).toHaveClass(/build/);
  const pos = await game(page, () => window.__pixelgame.game.renderer.worldToScreen(8.5, 1.5));
  await page.touchscreen.tap(pos.x, pos.y);
  expect(await game(page, () => window.__pixelgame.game.world.structureAt(8, 1)?.id)).toBe('wood_wall');
  await page.tap('#build-bar .done');
  await expect(page.locator('#build-bar')).toBeHidden();
  expect(errors).toEqual([]);
});

test('phone hotbar: tap to switch weapon slots and the pickaxe; the map opens from the dock', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  const size = page.viewportSize();
  const bar = await page.locator('#hotbar').boundingBox();
  const attack = await page.locator('#btn-attack').boundingBox();
  expect(bar.x + bar.width).toBeLessThanOrEqual(size.width);
  expect(bar.y + bar.height).toBeLessThanOrEqual(attack.y);
  for (const id of ['#slot-main', '#slot-secondary', '#slot-tool']) {
    const b = await page.locator(id).boundingBox();
    expect(b.width).toBeGreaterThanOrEqual(44); // comfortable touch target
  }
  await page.tap('#slot-tool');
  expect(await game(page, () => window.__pixelgame.game.activeSlot)).toBe('main');
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.save.tools.pickaxe = 1;
    g.emit('tools');
  });
  await page.tap('#slot-tool');
  expect(await game(page, () => window.__pixelgame.game.toolActive)).toBe(true);
  await expect(page.locator('#btn-ability')).toBeHidden();
  await page.tap('#slot-main');
  expect(await game(page, () => window.__pixelgame.game.activeSlot)).toBe('main');

  await page.tap('#btn-map');
  await expect(page.locator('.map-panel')).toBeVisible();
  const width = await page.evaluate(() => document.querySelector('.map-panel').offsetWidth);
  expect(width).toBe(size.width);
  await page.tap('.map-panel .close');
  await expect(page.locator('.map-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('phone: loot odds and boats fit the screen', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  await page.tap('#btn-menu');
  await page.tap('.menu button:has-text("Loot odds")');
  await expect(page.locator('.odds-table')).toBeVisible();
  const fit = await page.evaluate(() => ({
    panel: document.querySelector('.odds-panel').offsetWidth,
    page: document.documentElement.scrollWidth,
    w: innerWidth,
  }));
  expect(fit.panel).toBe(fit.w);
  expect(fit.page).toBeLessThanOrEqual(fit.w);
  await page.tap('.odds-panel .close');
  await game(page, () => { window.__pixelgame.game.save.base.buildings.forge = 1; });
  await page.tap('#btn-menu');
  await page.tap('.menu button:has-text("Forge")');
  await page.tap('.forge-panel .tab:has-text("Tools")');
  await expect(page.locator('.tool-card', { hasText: 'Log Raft' })).toBeVisible();
  expect(errors).toEqual([]);
});
