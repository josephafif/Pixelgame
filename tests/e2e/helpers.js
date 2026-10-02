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

/**
 * Stands in for the Supabase project (server list, join codes, login
 * settings), so lobby tests never need the internet.
 *   servers: rows list_game_servers returns
 *   codes:   { CODE: row } for find_game_server
 *   providers: { google, discord, email } switched on in Supabase Auth
 */
export async function stubSupabase(page, { servers = [], codes = {}, providers = {} } = {}) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const calls = [];
  await page.route('**/*.supabase.co/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(url.pathname);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (body) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (url.pathname === '/rest/v1/rpc/list_game_servers') return json(servers);
    if (url.pathname === '/rest/v1/rpc/find_game_server') {
      const code = String(JSON.parse(req.postData() ?? '{}').p_code ?? '').toUpperCase();
      return json(codes[code] ? [codes[code]] : []);
    }
    if (url.pathname === '/auth/v1/settings') return json({ external: providers });
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  });
  // The official server (on Cloudflare) answers like a live one.
  await page.route('**/*.workers.dev/**', (route) => {
    calls.push(route.request().url());
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify(official),
    });
  });
  return calls;
}

const official = {
  name: 'Pixelgame', protocol: 1, players: 3, maxPlayers: 40, guests: true, logins: true, supabase: true,
  rules: { safeRadius: 24, claimRadius: 16, raidWindow: 'lördag 18:00–21:00', raidGraceMinutes: 15, clanMax: 8, hardcore: false },
};
