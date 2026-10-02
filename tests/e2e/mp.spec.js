// Multiplayer in real browsers: two players join a real game server (started
// here, in-memory), see each other, chat and form a clan.

import { test, expect } from '@playwright/test';
import { startServer } from '../../server/index.js';
import { trackErrors } from './helpers.js';

let srv;
let base;

test.beforeAll(async () => {
  const quiet = { info() {}, debug() {}, warn() {}, error: (...a) => console.error(...a) };
  srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, serveStatic: true, devAdmins: true, log: quiet });
  base = `http://127.0.0.1:${srv.port}`;
});

test.afterAll(async () => {
  await srv?.stop();
});

async function join(browser, name, password = 'hemligt') {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await page.goto(`${base}/?debug=1`);
  await page.click('#title-multiplayer');
  const server = page.locator('.mp-server');
  await expect(server).toContainText('Pixelgame-servern');
  await server.locator('button', { hasText: 'Spela som gäst' }).click();
  await expect(page.locator('.mp-name input[type="text"]')).toBeVisible();
  await page.fill('.mp-name input[type="text"]', name);
  await page.fill('.mp-name input[type="password"]', password);
  await page.locator('.mp-name button').click();
  await page.waitForFunction(() => window.__pixelgame?.game?.connected);
  await expect(page.locator('#hud')).toBeVisible();
  return { page, ctx, errors };
}

test('two players see each other, chat and form a clan', async ({ browser }) => {
  const a = await join(browser, 'Anna');
  const b = await join(browser, 'Bertil');
  // Each sees the other, with their name, smoothly interpolated.
  await b.page.waitForFunction(() => window.__pixelgame.game.others.some((o) => o.name === 'Anna'));
  await a.page.waitForFunction(() => window.__pixelgame.game.others.some((o) => o.name === 'Bertil'));
  // The town is safe, and the HUD says so.
  await expect(a.page.locator('.mp-zone')).toContainText('Fristaden');
  // Walking: your own movement is predicted and the server agrees.
  await a.page.keyboard.down('KeyD');
  await a.page.waitForTimeout(700);
  await a.page.keyboard.up('KeyD');
  await a.page.waitForTimeout(400);
  const net = await a.page.evaluate(() => window.__pixelgame.game.netDebug());
  expect(net.bigCorrections).toBe(0);
  const bSees = await b.page.evaluate(() => window.__pixelgame.game.others.find((o) => o.name === 'Anna').x);
  const aIs = await a.page.evaluate(() => window.__pixelgame.game.player.x);
  expect(Math.abs(bSees - aIs)).toBeLessThan(1);
  // Chat.
  await a.page.keyboard.press('KeyT');
  await a.page.keyboard.type('Hej Bertil!');
  await a.page.keyboard.press('Enter');
  await expect(b.page.locator('.mp-chat-log')).toContainText('Hej Bertil!');
  // Clan through the panel.
  await a.page.keyboard.press('KeyB');
  await a.page.fill('.mp-clan input[placeholder="Klanens namn"]', 'Ulvarna');
  await a.page.fill('.mp-clan input[placeholder="TAGG"]', 'ULV');
  await a.page.locator('.mp-clan button.btn-primary').click();
  await expect(a.page.locator('.mp-clan-head')).toContainText('[ULV] Ulvarna');
  await expect(a.page.locator('.mp-clan-head')).toContainText('Ledare');
  await a.page.locator('.mp-clan input[placeholder="Spelarens namn"]').fill('Bertil');
  await a.page.locator('.mp-clan button', { hasText: 'Bjud in' }).click();
  await b.page.keyboard.press('KeyB');
  await b.page.locator('.mp-clan button', { hasText: 'Gå med' }).click();
  await expect(b.page.locator('.mp-clan-head')).toContainText('[ULV] Ulvarna');
  // Bertil's name tag now shows the clan.
  await b.page.keyboard.press('Escape');
  await a.page.waitForFunction(() => window.__pixelgame.game.others.find((o) => o.name === 'Bertil')?.tag === 'ULV');
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test('the inventory and forge open in multiplayer, and nobody can build in town', async ({ browser }) => {
  const a = await join(browser, 'Cecilia');
  await a.page.keyboard.press('KeyI');
  await expect(a.page.locator('.inventory-panel')).toBeVisible();
  await expect(a.page.locator('.inventory-panel .slot').first()).toBeVisible();
  await a.page.keyboard.press('Escape');
  await a.page.keyboard.press('KeyG');
  await expect(a.page.locator('.toast').last()).toContainText(/klan|Fristaden/);
  await a.page.evaluate(() => window.__pixelgame.game.chat('/tp -4.5 -1'));
  await a.page.waitForTimeout(500);
  await a.page.keyboard.press('KeyC');
  await expect(a.page.locator('.forge-panel')).toBeVisible();
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test('on a new link or device: log in with name and password and get your character back', async ({ browser }) => {
  const a = await join(browser, 'Doris', 'ostkaka');
  const level = await a.page.evaluate(() => window.__pixelgame.game.me?.level);
  await a.ctx.close();
  // A fresh browser knows nothing about Doris (as after a new share link).
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await page.goto(`${base}/?debug=1`);
  // Served by the game server: Multiplayer is the main button.
  await expect(page.locator('#title-multiplayer')).toHaveClass(/btn-primary/);
  await page.click('#title-multiplayer');
  const server = page.locator('.mp-server');
  await server.locator('button', { hasText: 'Logga in med namn' }).click();
  await page.fill('.mp-login input[type="text"]', 'doris');
  await page.fill('.mp-login input[type="password"]', 'felord');
  await page.locator('.mp-login button').click();
  await expect(page.locator('.mp-login .warn')).toContainText('Fel namn eller lösenord');
  await page.fill('.mp-login input[type="password"]', 'ostkaka');
  await page.locator('.mp-login button').click();
  await page.waitForFunction(() => window.__pixelgame?.game?.connected);
  expect(await page.evaluate(() => window.__pixelgame.game.myName)).toBe('Doris');
  expect(await page.evaluate(() => window.__pixelgame.game.me?.level)).toBe(level);
  // The menu lets a guest change the password.
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu-panel button', { hasText: 'Byt lösenord' })).toBeVisible();
  await page.locator('.menu-panel button', { hasText: 'Byt lösenord' }).click();
  await page.fill('.mp-name input[type="password"]', 'nyttlosen');
  await page.locator('.mp-name button').click();
  await expect(page.locator('.toast').last()).toContainText('Lösenordet är sparat');
  expect(errors.filter((e) => !/401/.test(e))).toEqual([]);
  await ctx.close();
});
