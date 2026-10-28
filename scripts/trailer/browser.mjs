// Starts the dev server and a headless Chromium with the game loaded on
// virtual time (timeshim.js), past the title screen and into the world.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');

/** Playwright: the project's own if installed, else the one on this machine. */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const require = createRequire(import.meta.url);
    for (const p of ['@playwright/test', '/opt/node-tools/node_modules/playwright']) {
      try {
        return require(p);
      } catch {
        // try the next
      }
    }
    throw new Error('Playwright is needed: npm install (or npm i -D playwright)');
  }
}

async function waitForServer(url, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The dev server did not start at ${url}`);
}

/**
 * @param {object} opts
 *   width, height — the video's size in pixels
 *   port — for the dev server
 *   worldSeed — the world the trailer is shot in
 * @returns {Promise<{ page, cdp, close }>}
 */
export async function openGame({ width = 1920, height = 1080, port = 4199, worldSeed = 20260, log = false } = {}) {
  const server = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs'), '--port', String(port)], { stdio: 'ignore' });
  const base = `http://localhost:${port}/`;
  await waitForServer(base);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    hasTouch: false,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || log) console.log(`[page ${m.type()}]`, m.text());
  });
  await page.addInitScript({ content: readFileSync(join(here, 'timeshim.js'), 'utf8') });
  // A fresh world with a known seed, and settings made for filming.
  await page.addInitScript(({ worldSeed }) => {
    // The first seed the game asks for is the world's; the rest come from
    // the seeded Math.random, so a take can be shot again exactly.
    let worldPending = true;
    crypto.getRandomValues = (arr) => {
      if (worldPending && arr instanceof Uint32Array && arr.length === 1) {
        worldPending = false;
        arr[0] = worldSeed >>> 0;
        return arr;
      }
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 2 ** (8 * (arr.BYTES_PER_ELEMENT ?? 1)));
      return arr;
    };
  }, { worldSeed });
  await page.goto(`${base}?debug=1`);
  await page.waitForFunction(() => window.__pixelgame?.game && !document.querySelector('#title')?.hidden, null, { timeout: 30_000 });
  const cdp = await context.newCDPSession(page);
  return {
    page,
    cdp,
    base,
    async close() {
      await browser.close().catch(() => {});
      server.kill();
    },
  };
}

/**
 * Past the title screen into the world: the tutorial and the starter
 * weapon's card are dismissed, settings set for filming, the stagehands
 * (stage.js) and the director loaded, and the page's clock frozen.
 */
export async function enterWorld(page, { director = null } = {}) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      while (!fn() && Date.now() < end) await wait(50);
    };
    document.querySelector('#title-play').click();
    await until(() => document.querySelector('.tutorial button'));
    document.querySelector('.tutorial button')?.click();
    await until(() => document.querySelector('.discovery .btn-primary'));
    document.querySelector('.discovery .btn-primary')?.click();
    await until(() => !document.querySelector('.discovery'));
    const g = window.__pixelgame.game;
    g.updateSettings({ quality: 'high', volume: 0, sfx: false, damageNumbers: true, screenShake: true, viewSize: 'normal' });
    g.saveNow = async () => true; // nothing filmed is kept
    window.__stage = await import('/scripts/trailer/stage.js');
    window.__stage.takeControls();
  });
  if (director) await page.evaluate(async (url) => {
    window.__director = await import(url);
    await window.__director.prepare?.();
  }, director);
  await page.evaluate(() => window.__vt.freeze());
}

/** One frame of the page as a JPEG (or PNG) buffer. */
export async function capture(cdp, { format = 'jpeg', quality = 92, clip = null } = {}) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format, quality: format === 'jpeg' ? quality : undefined, optimizeForSpeed: true, captureBeyondViewport: false,
    ...(clip ? { clip } : {}),
  });
  return Buffer.from(data, 'base64');
}
