import { expect } from '@playwright/test';

/** Collects page errors and console errors so tests can assert none happened. */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Opens the app, starts a game and equips the starter weapon. */
export async function startGame(page, { tap = false } = {}) {
  await page.goto('/?debug=1');
  await expect(page.locator('#title')).toBeVisible();
  const press = (sel) => (tap ? page.tap(sel) : page.click(sel));
  await press('#title-play');
  const tutorial = page.locator('.tutorial button');
  if (await tutorial.isVisible().catch(() => false)) await press('.tutorial button');
  const discovery = page.locator('.discovery');
  await expect(discovery).toBeVisible();
  await expect(page.locator('.discovery-banner')).toHaveText('NEW WEAPON DISCOVERED');
  await press('.discovery .btn-primary');
  await expect(discovery).toBeHidden();
}

export function game(page, fn, arg) {
  return page.evaluate(fn, arg);
}
