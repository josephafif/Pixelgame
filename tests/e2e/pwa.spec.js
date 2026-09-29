import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { trackErrors, startGame, game } from './helpers.js';

const MANIFEST = fileURLToPath(new URL('../../precache-manifest.js', import.meta.url));

test('installable: manifest and service worker are in place', async ({ page }) => {
  await page.goto('/');
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  expect(manifest.display).toBe('standalone');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});

test('starts and plays offline after the first visit', async ({ page, context }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#title-status')).toContainText('Offline');
  await expect(page.locator('#title-status')).toContainText('Offline play ready');
  await startGame(page);
  await expect(page.locator('#net-status')).toHaveText('● Offline');
  expect(await game(page, () => window.__pixelgame.game.weapon !== null)).toBe(true);
  await context.setOffline(false);
  expect(errors.filter((e) => !e.includes('net::ERR_INTERNET_DISCONNECTED'))).toEqual([]);
});

test('a new version is announced and installed without losing progress', async ({ page }) => {
  const original = readFileSync(MANIFEST, 'utf8');
  try {
    await page.goto('/?debug=1');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await startGame(page);

    const version = original.match(/"version": "([^"]+)"/)[1];
    writeFileSync(MANIFEST, original.replace(version, 'e2e-update'));
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await expect(page.locator('#update-banner')).toBeVisible({ timeout: 20_000 });

    // "Later" keeps playing; the banner can be dismissed.
    await page.click('#update-later');
    await expect(page.locator('#update-banner')).toBeHidden();

    // Unsaved in-memory progress must survive "Update now".
    await game(page, () => { window.__pixelgame.game.save.resources.essence = 4242; });
    await page.keyboard.press('Escape');
    await Promise.all([
      page.waitForEvent('load', { timeout: 20_000 }),
      page.click('.menu button:has-text("Update available")'),
    ]);
    await expect(page.locator('#title')).toBeVisible();
    const after = await page.evaluate(async () => ({
      essence: window.__pixelgame.game.save.resources.essence,
      caches: (await caches.keys()).filter((k) => k.startsWith('pixelgame-shell-')),
    }));
    expect(after.essence).toBe(4242);
    expect(after.caches).toEqual(['pixelgame-shell-e2e-update']);
  } finally {
    writeFileSync(MANIFEST, original);
  }
});
