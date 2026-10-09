// Multiplayer in real browsers: two players join a real game server (started
// here, in-memory), see each other, chat and form a clan.

import { test, expect } from '@playwright/test';
import { startServer } from '../../server/index.js';
import { trackErrors, stubSupabase } from './helpers.js';

let srv;
let base;

test.beforeAll(async () => {
  const quiet = { info() {}, debug() {}, warn() {}, error: (...a) => console.error(...a) };
  // A fixed world (one with open sea within reach, for the sailing test).
  srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, serveStatic: true, devAdmins: true, worldSeed: 42, log: quiet });
  base = `http://127.0.0.1:${srv.port}`;
});

test.afterAll(async () => {
  await srv?.stop();
});

async function join(browser, name, password = 'hemligt') {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await stubSupabase(page);
  await page.goto(`${base}/?debug=1`);
  await page.click('#title-multiplayer');
  const server = page.locator('.mp-server');
  await expect(server).toContainText('Pixelgame-servern');
  await server.locator('button', { hasText: 'Ny karaktär' }).click();
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

test('a legendary power in multiplayer: the button, its cooldown and its effects', async ({ browser }) => {
  const a = await join(browser, 'Legenden');
  const p = [...srv.gs.players.values()].find((x) => x.name === 'Legenden');
  // A legendary weapon, straight into the bag.
  const loot = await import('../../server/loot.js');
  // (One whose power hurts on its own: Ascension only makes you stronger.)
  const { effectiveAbility } = await import('../../src/weapons/legendary.js');
  let dna;
  do dna = loot.generate(srv.gs, { level: 20, minRarity: 'legendary', maxRarity: 'legendary', craft: {} });
  while (!effectiveAbility(srv.gs.data, dna) || effectiveAbility(srv.gs.data, dna).action === 'ascend');
  loot.giveWeapon(srv.gs, p, dna, 'test');
  await a.page.waitForTimeout(300);
  await a.page.evaluate((id) => window.__pixelgame.game.equip(id, 'main'), dna.id);
  await a.page.waitForFunction((id) => window.__pixelgame.game.weapon?.dna.id === id, dna.id);
  // (The touch buttons only show on touch screens; on a computer it is the Q key.)
  await expect(a.page.locator('#btn-ability')).not.toHaveAttribute('hidden', '');
  await expect(a.page.locator('#btn-ability')).toHaveClass(/legendary/);
  await expect(a.page.locator('#btn-ability')).toHaveClass(/ready/);
  // Out in the wild with monsters around.
  await a.page.evaluate(() => window.__pixelgame.game.chat('/tp 120.5 0.5'));
  await a.page.waitForTimeout(600);
  p.protectUntil = Date.now() + 60000;
  const { spawnEnemy } = await import('../../server/enemies.js');
  const foes = [[2, 0], [-2, 0.5], [0.5, 2]].map(([dx, dy]) => {
    const spot = srv.gs.world.findFreeSpot(p.x + dx, p.y + dy, 0.4);
    const e = spawnEnemy(srv.gs, 'slime', spot.x, spot.y, { level: 1 });
    e.hp = e.maxHp = 1e6;
    return e;
  });
  await a.page.waitForTimeout(300);
  await a.page.keyboard.press('KeyQ');
  // The cooldown shows on the button, and the power hurts the monsters.
  await expect(a.page.locator('#btn-ability')).not.toHaveClass(/ready/, { timeout: 3000 });
  await expect.poll(() => foes.filter((e) => e.hp < e.maxHp).length, { timeout: 8000 }).toBeGreaterThan(0);
  expect(await a.page.evaluate(() => window.__pixelgame.game.hudState().ability?.ready)).toBe(false);
  await a.page.waitForTimeout(1500);
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test('pals in multiplayer: your pal walks with you, shows in the HUD, and the pals panel works', async ({ browser }) => {
  const a = await join(browser, 'Djurvan');
  const p = [...srv.gs.players.values()].find((x) => x.name === 'Djurvan');
  p.ch.level = 8;
  p.ch.extra.pals = {
    eggs: [{ id: 'egg2', species: 'emberpup', hatchAt: null }],
    owned: [{ id: 'pal1', species: 'glimmerfox', name: 'Glimmerfox', level: 2 }],
    active: 'pal1', mode: 'fight', nextId: 3,
  };
  const pals = await import('../../server/pals.js');
  const players = await import('../../server/players.js');
  pals.sync(srv.gs, p);
  players.markMe(p);
  await a.page.waitForFunction(() => window.__pixelgame.game.pal?.species === 'glimmerfox');
  await expect(a.page.locator('#hud-pal')).toBeVisible();
  await a.page.keyboard.press('KeyH');
  await expect(a.page.locator('.pals-panel')).toBeVisible();
  await expect(a.page.locator('.pals-panel .pal-card.active')).toContainText('Glimmerfox');
  await expect(a.page.locator('.pals-panel .egg-card')).toBeVisible();
  // Switch it to gathering, through the server.
  await a.page.locator('.pals-panel [data-mode="gather"]').click();
  await expect.poll(() => p.ch.extra.pals.mode).toBe('gather');
  // Warm the egg in the Den.
  p.ch.resources.essence = 500;
  players.markMe(p);
  await a.page.waitForTimeout(200);
  await a.page.locator('.pals-panel [data-action="hatch"]').click();
  await expect.poll(() => Boolean(p.ch.extra.pals.eggs[0]?.hatchAt)).toBe(true);
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test('sailing in multiplayer: set sail at the shore and sail smoothly (predicted like walking)', async ({ browser }) => {
  const a = await join(browser, 'Kaptenen');
  const p = [...srv.gs.players.values()].find((x) => x.name === 'Kaptenen');
  p.ch.extra.boat = 2;
  p.protectUntil = Date.now() + 10 * 60 * 1000;
  const players = await import('../../server/players.js');
  players.markMe(p);
  // A shore with open sea to the east.
  const { T, SAILABLE } = await import('../../src/game/world.js');
  const w = srv.gs.world;
  let shore = null;
  for (let r = 40; r < 400 && !shore; r += 2) {
    for (let k = 0; k < 64 && !shore; k++) {
      const x = Math.floor(Math.cos((k / 64) * Math.PI * 2) * r);
      const y = Math.floor(Math.sin((k / 64) * Math.PI * 2) * r);
      if (w.blockAt(x, y) || !w.isFree(x + 0.5, y + 0.5, 0.32)) continue;
      if (w.blockAt(x + 1, y) !== T.SEA || !SAILABLE.has(w.blockAt(x + 3, y)) || !w.isFree(x + 1.5, y + 0.5, 0.32, 'boat')) continue;
      shore = { x: x + 0.5, y: y + 0.5 };
    }
  }
  expect(shore).not.toBeNull();
  await a.page.evaluate(([x, y]) => window.__pixelgame.game.chat(`/tp ${x} ${y}`), [shore.x, shore.y]);
  await a.page.waitForTimeout(700);
  // Face the sea, then Use.
  await a.page.keyboard.down('KeyD');
  await a.page.waitForTimeout(250);
  await a.page.keyboard.up('KeyD');
  await expect.poll(() => a.page.evaluate(() => window.__pixelgame.game.interactTarget?.type)).toBe('launch');
  await a.page.keyboard.press('KeyE');
  await a.page.waitForFunction(() => window.__pixelgame.game.sailing);
  const before = await a.page.evaluate(() => window.__pixelgame.game.netStats.bigCorrections);
  await a.page.keyboard.down('KeyD');
  await a.page.waitForTimeout(1200);
  await a.page.keyboard.up('KeyD');
  await a.page.waitForTimeout(300);
  const after = await a.page.evaluate(() => {
    const g = window.__pixelgame.game;
    return { big: g.netStats.bigCorrections, x: g.player.x, y: g.player.y, err: g.netStats.lastError };
  });
  expect(after.big).toBe(before);
  expect(after.x).toBeGreaterThan(shore.x + 2);
  expect(Math.abs(after.x - p.x)).toBeLessThan(0.3);
  expect(p.sailing).toBe(true);
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test('markets in multiplayer: walls and merchants, the market panel, buying', async ({ browser }) => {
  const a = await join(browser, 'Kunden');
  const p = [...srv.gs.players.values()].find((x) => x.name === 'Kunden');
  p.protectUntil = Date.now() + 10 * 60 * 1000;
  const m = srv.gs.world.firstMarket;
  await a.page.evaluate(([x, y]) => window.__pixelgame.game.chat(`/tp ${x} ${y}`), [m.x + 0.5, m.y + m.r + 3]);
  await expect.poll(() => a.page.evaluate(() => window.__pixelgame.game.markets.structures.length)).toBeGreaterThan(10);
  await expect.poll(() => a.page.evaluate(() => window.__pixelgame.game.markets.npcs.length)).toBeGreaterThan(1);
  const entry = srv.gs.markets.get(m.id);
  const merchant = entry.npcs.find((n) => n.role === 'merchant');
  p.ch.resources.gold = 5000;
  const players = await import('../../server/players.js');
  players.markMe(p);
  await a.page.evaluate(([x, y]) => window.__pixelgame.game.chat(`/tp ${x} ${y}`), [merchant.x, merchant.y + 1.3]);
  await expect.poll(() => a.page.evaluate(() => window.__pixelgame.game.interactTarget?.type)).toBe('merchant');
  await a.page.keyboard.press('KeyE');
  await expect(a.page.locator('.market-panel')).toBeVisible();
  const wood0 = p.ch.resources.wood ?? 0;
  const row = a.page.locator('.market-panel .mrow', { hasText: 'Wood' }).first();
  await row.locator('button').click();
  await expect.poll(() => p.ch.resources.wood ?? 0).toBe(wood0 + 20);
  await expect(row.locator('.badge')).toHaveText('Sold');
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
  await stubSupabase(page);
  await page.goto(`${base}/?debug=1`);
  // Served by the game server: Multiplayer is the main button.
  await expect(page.locator('#title-multiplayer')).toHaveClass(/btn-primary/);
  await page.click('#title-multiplayer');
  const server = page.locator('.mp-server');
  await server.locator('button', { hasText: /^Logga in$/ }).click();
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
  // The game remembers who you are: next time it is one click.
  await page.goto(`${base}/?debug=1`);
  await page.click('#title-multiplayer');
  await expect(page.locator('.mp-server button', { hasText: 'Spela som Doris' })).toBeVisible();
  // If that saved login stops working (a new world on the same address), you log in right there.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('pg-mp-guest:')) localStorage.setItem(key, JSON.stringify({ token: 'guest.e30.AAAA', name: 'Doris', password: true }));
    }
  });
  await page.locator('.mp-server button', { hasText: 'Spela som Doris' }).click();
  await expect(page.locator('.mp-name')).toContainText('Logga in på');
  await expect(page.locator('.mp-name input[type="text"]')).toHaveValue('Doris');
  await page.fill('.mp-name input[type="password"]', 'nyttlosen');
  await page.locator('.mp-name button', { hasText: 'Logga in' }).click();
  await page.waitForFunction(() => window.__pixelgame?.game?.connected);
  expect(await page.evaluate(() => window.__pixelgame.game.myName)).toBe('Doris');
  expect(errors.filter((e) => !/401/.test(e))).toEqual([]);
  await ctx.close();
});

test('on the game\'s website: the official server, a friend\'s server by its code, and an invitation link', async ({ browser, baseURL }) => {
  // The page comes from the static site (like Netlify); the servers are elsewhere.
  const official = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, serverName: 'Pixelgame', log: { info() {}, debug() {}, warn() {}, error: console.error } });
  const friend = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, serverName: 'Annas server', log: { info() {}, debug() {}, warn() {}, error: console.error } });
  const row = (srv, code, extra) => ({ code, name: srv.config.serverName, url: `http://127.0.0.1:${srv.port}`, official: false, players: 0, max_players: 50, protocol: 1, online: true, ...extra });
  const stub = {
    servers: [row(official, 'PIXEL1', { official: true })],
    codes: { K7QX2M: row(friend, 'K7QX2M'), ZZZZZZ: row(friend, 'ZZZZZZ', { online: false }) },
  };
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = trackErrors(page);
    await stubSupabase(page, stub);
    // An invitation link opens the lobby on the friend's server.
    await page.goto(`${baseURL}/?join=k7qx2m&debug=1`);
    const found = page.locator('.mp-friends .mp-server');
    await expect(found).toContainText('Annas server');
    await expect(found).toContainText('K7QX2M');
    await expect(found).toContainText('0/50 spelare');
    // The official servers are listed too (the configured one and the list's).
    await expect(page.locator('.mp-official .mp-server')).toHaveCount(2);
    await expect(page.locator('.mp-official .mp-server').first()).toContainText('Pixelgame');
    // A code that isn't running, and one that doesn't exist.
    await page.fill('.mp-join input', 'zzzzzz');
    await page.locator('.mp-join button').click();
    await expect(page.locator('.mp-friends .mp-server')).toContainText('Inte igång just nu');
    await page.fill('.mp-join input', 'AAAAAA');
    await page.locator('.mp-join button').click();
    await expect(page.locator('.mp-friends .warn')).toContainText('Ingen server har koden AAAAAA');
    // Join the friend's server by its code, as a new character with a password.
    await page.fill('.mp-join input', 'K7QX2M');
    await page.locator('.mp-join button').click();
    await page.locator('.mp-friends .mp-server button', { hasText: 'Ny karaktär' }).click();
    await expect(page.locator('.mp-name input[type="text"]')).toBeVisible();
    await expect(page.locator('.mp-name')).toContainText('Använd inte ett lösenord');
    await page.fill('.mp-name input[type="text"]', 'Vännen');
    await page.fill('.mp-name input[type="password"]', 'hemligt');
    await page.locator('.mp-name button').click();
    await page.waitForFunction(() => window.__pixelgame?.game?.connected);
    expect(await page.evaluate(() => window.__pixelgame.game.serverInfo.name)).toBe('Annas server');
    // The login is kept by the code (the friend's address changes every time they start).
    expect(await page.evaluate(() => Boolean(localStorage.getItem('pg-mp-guest:code:K7QX2M')))).toBe(true);
    // Back in the lobby: the code is remembered, and you play on as yourself with one click.
    await page.goto(`${baseURL}/?debug=1`);
    await page.click('#title-multiplayer');
    await page.locator('.mp-recent button', { hasText: 'K7QX2M' }).click();
    await expect(page.locator('.mp-friends .mp-server button', { hasText: 'Spela som Vännen' })).toBeVisible();
    expect(errors).toEqual([]);
    await ctx.close();
  } finally {
    await official.stop();
    await friend.stop();
  }
});
