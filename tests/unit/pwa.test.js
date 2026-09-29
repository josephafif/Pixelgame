import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest } from '../../scripts/build-precache.mjs';
import { ROOT, readJson } from './helpers.js';

test('web app manifest has everything needed to install', () => {
  const m = readJson('manifest.webmanifest');
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'theme_color', 'background_color', 'description']) {
    assert.ok(m[key], key);
  }
  assert.equal(m.display, 'standalone');
  assert.equal(m.orientation, 'any', 'supports portrait and landscape');
  const sizes = new Set(m.icons.map((i) => i.sizes));
  for (const s of ['192x192', '512x512']) assert.ok(sizes.has(s), s);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of m.icons) assert.ok(existsSync(join(ROOT, icon.src)), icon.src);
});

test('precache manifest is up to date with the app files', () => {
  const built = buildManifest();
  const committed = readFileSync(join(ROOT, 'precache-manifest.js'), 'utf8');
  assert.equal(committed, built.source, 'run `npm run build` after changing app files');
});

test('every app module and asset is precached, so the app loads offline', () => {
  const { shell, data } = buildManifest();
  const all = new Set([...shell, ...data]);
  const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
  for (const file of walk('src')) assert.ok(all.has(file), file);
  for (const file of ['index.html', 'manifest.webmanifest', 'css/app.css', 'data/v1/gamedata.json', 'icons/icon-192.png']) {
    assert.ok(all.has(file), file);
  }
  for (const file of all) assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
});

test('index.html links the manifest, icons and entry module', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /<script type="module" src="src\/main.js">/);
  assert.match(html, /viewport-fit=cover/);
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  for (const ref of refs) assert.ok(existsSync(join(ROOT, ref)), ref);
});

test('service worker keeps saves safe and versions its caches', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /pixelgame-shell-\$\{version\}/);
  assert.match(sw, /SKIP_WAITING/);
  assert.doesNotMatch(sw, /indexedDB/, 'the worker never touches save data');
  assert.doesNotMatch(sw, /self\.skipWaiting\(\);\s*\}\);?\s*$/m, 'no unconditional skipWaiting on install');
});
