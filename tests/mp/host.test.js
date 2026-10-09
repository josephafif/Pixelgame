// The server manager (scripts/host.mjs): its control panel's API only obeys
// this computer with the right key; it starts and stops the server, shows
// who is online, kicks, bans, makes admins, saves settings (and restarts),
// makes backups, a brand new world, and restores an old one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, createServer } from 'node:http';
import { Host, startPanel, cleanSettings, panelKey, DEFAULT_SETTINGS } from '../../scripts/host.mjs';
import { Bot, sleep } from './bot.js';

/** A port nobody uses right now. */
async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('settings are checked (with Swedish messages)', async () => {
  const ok = await cleanSettings({ name: '  Vår   server ', admins: 'Anna, Kalle,, Anna' });
  assert.equal(ok.name, 'Vår server');
  assert.deepEqual(ok.admins, ['Anna', 'Kalle']);
  await assert.rejects(cleanSettings({ name: 'x' }), /Servernamnet/);
  await assert.rejects(cleanSettings({ port: 80 }), /Porten/);
  await assert.rejects(cleanSettings({ worldSeed: 'abc' }), /Världsfröet/);
  await assert.rejects(cleanSettings({ rules: { raidWindow: 'lördag kväll' } }), /Raidfönstret/);
  assert.equal((await cleanSettings({ rules: { raidWindow: '' } })).rules.raidWindow, '');
  assert.equal(DEFAULT_SETTINGS.tunnel, true, 'friends over the internet by default');
});

test('server manager: the panel controls the server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixelhost-'));
  const host = new Host({ dataDir: dir, echo: false });
  host.settings = { ...host.settings, port: await freePort(), tunnel: false };
  const key = panelKey(dir);
  assert.equal(panelKey(dir), key, 'the same key next time (bookmarks keep working)');
  const panel = await startPanel(host, { port: 0, key });
  const base = `http://127.0.0.1:${panel.port}`;
  const api = async (path, body) => {
    const res = await fetch(`${base}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-host-key': key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  };
  let bot = null;
  try {
    // The page itself, and the locks on its API.
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Serverhanteraren/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(`${base}/api/status`)).status, 403, 'no key, no control');
    assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-host-key': 'fel' } })).status, 403);
    const evil = await fetch(`${base}/api/start`, { method: 'POST', headers: { 'x-host-key': key, origin: 'https://evil.example' }, body: '{}' });
    assert.equal(evil.status, 403, 'never for another web page');
    const rebind = await rawGet(panel.port, '/api/status', { host: 'evil.example:8790', 'x-host-key': key });
    assert.equal(rebind.status, 403, 'not through another site\'s name for this computer');

    let s = await api('status');
    assert.equal(s.state, 'stopped');
    assert.match((await api('kick', { name: 'x' })).error, /Starta servern först/);

    // Start: a player joins and shows up in the list.
    assert.equal((await api('start', {})).ok, true);
    s = await api('status');
    assert.equal(s.state, 'running');
    const port = host.server.port;
    assert.equal(s.local, `http://localhost:${port}`);
    bot = await new Bot(`ws://127.0.0.1:${port}/ws`, { name: 'Gästen', password: 'hemligt' }).connect();
    await sleep(150);
    s = await api('status');
    assert.deepEqual(s.players.map((p) => p.name), ['Gästen']);
    assert.equal(s.players[0].where, 'Fristaden');
    assert.ok(s.stats.accounts >= 1);
    assert.ok(s.logs.some((l) => /igång/.test(l.text)), 'the log');

    // Tools.
    assert.equal((await api('announce', { text: 'Hej allihop!' })).ok, true);
    await bot.waitFor((m) => m.t === 'toast' && m.text === 'Hej allihop!');
    assert.equal((await api('admin', { name: 'Gästen', on: true })).ok, true);
    assert.equal(host.server.gs.byAccount.get(host.server.gs.db.accountByName('Gästen').id).isAdmin, true);
    assert.deepEqual(host.settings.admins, ['Gästen']);
    let r = await api('password', { name: 'Gästen', password: 'nytt-lösen' });
    assert.equal(r.ok, true, r.error);
    r = await api('backup', {});
    assert.equal(r.ok, true, r.error);
    assert.ok(existsSync(join(dir, 'backups', r.file)));
    const backup = r.file;
    assert.equal((await api('kick', { name: 'Gästen' })).ok, true);
    await bot.waitFor((m) => m.t === 'kick');
    r = await api('ban', { name: 'Gästen', hours: 1 });
    assert.equal(r.ok, true, r.error);
    assert.ok(host.server.gs.db.accountByName('Gästen').banned_until > Date.now());
    assert.equal((await api('unban', { name: 'Gästen' })).ok, true);

    // Settings: checked, saved, and the server restarts with them.
    r = await api('settings', { settings: { rules: { raidWindow: 'någon gång' } } });
    assert.equal(r.status, 400);
    assert.match(r.error, /Raidfönstret/);
    r = await api('settings', { settings: { name: 'Kompisservern', port, rules: { deathDrop: 20 } } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.restart, true);
    s = await api('status');
    assert.equal(s.state, 'running');
    assert.equal(host.server.config.serverName, 'Kompisservern');
    assert.equal(host.server.gs.rules.deathDrop, 0.2);

    // A brand new world (the old one kept), then back to the old one.
    assert.match((await api('newworld', { confirm: 'ja' })).error, /NY VÄRLD/);
    r = await api('newworld', { confirm: 'NY VÄRLD' });
    assert.equal(r.ok, true, r.error);
    assert.match(r.kept, /^gammal-varld-/);
    assert.equal(host.server.gs.db.accountByName('Gästen'), null, 'nobody in the new world');
    r = await api('restore', { file: '../settings.json' });
    assert.match(r.error, /säkerhetskopia/);
    r = await api('restore', { file: backup });
    assert.equal(r.ok, true, r.error);
    assert.ok(host.server.gs.db.accountByName('Gästen'), 'the old world is back');
    s = await api('status');
    assert.ok(s.backups.some((b) => b.file.startsWith('fore-aterstallning-')), 'the world before it was kept too');

    assert.equal((await api('stop', {})).ok, true);
    assert.equal((await api('status')).state, 'stopped');
  } finally {
    bot?.ws.close();
    await host.shutdown();
    await panel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server manager: a busy port is explained, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixelhost-'));
  const a = new Host({ dataDir: join(dir, 'a'), echo: false });
  const b = new Host({ dataDir: join(dir, 'b'), echo: false });
  try {
    a.settings = { ...a.settings, port: await freePort(), tunnel: false };
    await a.start();
    b.settings = { ...b.settings, port: a.server.port, tunnel: false };
    await b.start();
    assert.equal(b.state, 'stopped');
    assert.match(b.error, /används redan/);
  } finally {
    await a.shutdown();
    await b.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
