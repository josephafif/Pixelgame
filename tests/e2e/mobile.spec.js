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

test('build mode on a phone: tap a tile to pick it, tap again to build, drag for a line, walk on the left', async ({ page, context }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  await game(page, () => {
    const g = window.__pixelgame.game;
    Object.assign(g.save.resources, { wood: 100 });
    g.player.x = 0.5;
    g.player.y = 6.5;
    g.renderer.snapCamera();
  });
  await page.waitForTimeout(300);
  await page.tap('#btn-build');
  await expect(page.locator('#build-bar')).toBeVisible();
  await expect(page.locator('#btn-attack')).toHaveClass(/build/);
  // The bar is a slim strip, so the camp stays in view.
  const bar = await page.locator('#build-bar').boundingBox();
  const vh = page.viewportSize().height;
  expect(bar.height).toBeLessThan(vh * 0.2);
  const at = (tx, ty) => game(page, ([x, y]) => window.__pixelgame.game.renderer.worldToScreen(x + 0.5, y + 0.5), [tx, ty]);
  const built = (tx, ty) => game(page, ([x, y]) => window.__pixelgame.game.world.structureAt(x, y)?.id ?? null, [tx, ty]);
  // Tiles on the open south side of the camp plaza (no trees, no buildings).
  // A tap on the left half (the joystick side) picks the tile instead of walking.
  const start = await game(page, () => ({ x: window.__pixelgame.game.player.x, y: window.__pixelgame.game.player.y }));
  const t = await at(-2, 4);
  await page.touchscreen.tap(t.x, t.y);
  await expect.poll(() => game(page, () => window.__pixelgame.game.build.ghost)).toEqual({ tx: -2, ty: 4 });
  expect(await built(-2, 4)).toBeNull();
  // Tapping the picked tile builds there.
  await page.touchscreen.tap(t.x, t.y);
  await expect.poll(() => built(-2, 4)).toBe('wood_wall');
  // Pick the next tile and drag a line from it.
  const cdp = await context.newCDPSession(page);
  const a = await at(-1, 4);
  await page.touchscreen.tap(a.x, a.y);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + i * 8, y: a.y, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => built(-1, 4)).toBe('wood_wall');
  expect(await built(0, 4)).toBe('wood_wall');
  const moved = await game(page, ({ x, y }) => Math.hypot(window.__pixelgame.game.player.x - x, window.__pixelgame.game.player.y - y), start);
  expect(moved).toBeLessThan(0.01);
  // The hammer builds on the picked tile too.
  const b = await at(2, 8);
  await page.touchscreen.tap(b.x, b.y);
  await page.tap('#btn-attack');
  await expect.poll(() => built(2, 8)).toBe('wood_wall');
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

test('phone HUD stays out of the way: compact notices, a quiet resource line, a wider view', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  // Upright phones see more of the world than the desktop default.
  const tilesWide = await game(page, () => window.__pixelgame.game.renderer.view.width / 16);
  expect(tilesWide).toBeGreaterThanOrEqual(16);
  // Notices: at most two, and repeats count up instead of stacking.
  await game(page, () => {
    const g = window.__pixelgame.game;
    g.toast('You found a market!', 'component');
    g.toast('+3 wood');
    g.toast('+3 wood');
    g.toast('Level 2! You feel stronger.', 'level');
  });
  const toasts = page.locator('#toasts .toast');
  await expect(toasts).toHaveCount(2);
  await expect(toasts.first()).toContainText('market');
  // The HUD plate is small.
  const plate = await page.locator('.hud-player').boundingBox();
  expect(plate.height).toBeLessThan(56);
  expect(plate.width).toBeLessThanOrEqual(200);
  // The weapon name only shows for a moment.
  await page.waitForTimeout(2600);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#hud-weapon')).opacity)).toBe('0');
  // The resource line lights up when something changes.
  await game(page, () => { window.__pixelgame.game.save.resources.essence += 5; });
  await expect(page.locator('.res-row')).toHaveClass(/\blit\b/);
  expect(errors).toEqual([]);
});

test('phone: the pal chip sits under your health bar, clear of notices; the pals panel fits', async ({ page }) => {
  const errors = trackErrors(page);
  await startGame(page, { tap: true });
  await game(page, async () => {
    const g = window.__pixelgame.game;
    const { addEgg } = await import('/src/game/pals.js');
    g.save.base.buildings.den = 1;
    const egg = addEgg(g.data, g.save, 'glimmerfox');
    egg.hatchAt = Date.now() - 1;
    g.checkHatch();
  });
  const chip = page.locator('#hud-pal');
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  const plate = await page.locator('.hud-player').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(plate.y + plate.height - 2);
  expect(box.y + box.height).toBeLessThanOrEqual(70);
  await page.tap('#btn-menu');
  await page.tap('.menu button:has-text("Pals")');
  const panel = page.locator('.pals-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.pal-card.active')).toContainText('Glimmerfox');
  const fits = await page.evaluate(() => {
    const body = document.querySelector('.pals-panel .panel-body');
    return body.scrollWidth <= body.clientWidth + 1;
  });
  expect(fits).toBe(true);
  expect(errors).toEqual([]);
});
