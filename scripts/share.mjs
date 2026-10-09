#!/usr/bin/env node
// npm run share: multiplayer from your own computer, free, in one step.
//
// Starts the game server (it also serves the game itself) and a Cloudflare
// quick tunnel, which gives this computer a public https:// address. It needs
// no account, no card and no router settings.
//
//  - The tunnel's address changes every time you start; the join code below
//    doesn't. Players choose a password with their name, so they can also
//    log in from another device.
//  - You play at http://localhost:8787 and are admin there (/help in the chat).
//  - Everything is saved in server-data/pixelgame.db. Ctrl+C saves and stops.
//
// cloudflared (Cloudflare's tunnel program) is used if it is installed.
// Otherwise it is downloaded once, from Cloudflare's releases on GitHub,
// into server-data/bin/.
//
// The server gets a join code from the game's server list (Supabase), the
// same code every time: friends write it under Multiplayer on the game's
// website, or open the invitation link. --public also shows the server in
// the list for everyone.
//
// Options: --port 8787   --name "Our server"   --public   --no-tunnel (only this computer)

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(root, 'server-data', 'bin');
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/** Which cloudflared release file runs on this computer. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return { file: `cloudflared-windows-${arch === 'ia32' ? '386' : 'amd64'}.exe`, bin: 'cloudflared.exe' };
  if (platform === 'darwin') return { file: `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`, bin: 'cloudflared', tgz: true };
  const linux = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[arch];
  if (platform === 'linux' && linux) return { file: `cloudflared-linux-${linux}`, bin: 'cloudflared' };
  return null;
}

/** The tunnel's public address in cloudflared's log (never api.trycloudflare.com). */
export function tunnelUrl(text) {
  return /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/.exec(text)?.[0] ?? null;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const say = (...lines) => console.log(lines.join('\n'));

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  say('', `  ┌${'─'.repeat(width)}┐`, ...lines.map((l) => `  │  ${l.padEnd(width - 4)}  │`), `  └${'─'.repeat(width)}┘`, '');
}

// --- cloudflared ----------------------------------------------------------------------

function works(cmd) {
  try {
    return spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
}

async function download(asset) {
  mkdirSync(BIN_DIR, { recursive: true });
  const res = await fetch(`${RELEASES}/${asset.file}`);
  if (!res.ok || !res.body) throw new Error(`GitHub svarade ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = join(BIN_DIR, `${asset.file}.part`);
  let got = 0;
  let shown = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== shown && process.stdout.isTTY) {
      shown = pct;
      process.stdout.write(`\r  Laddar ner cloudflared… ${pct >= 0 ? `${pct} %` : `${Math.round(got / 1e6)} MB`}   `);
    }
  });
  await pipeline(body, createWriteStream(tmp));
  if (process.stdout.isTTY) process.stdout.write('\n');
  const bin = join(BIN_DIR, asset.bin);
  if (asset.tgz) {
    const out = spawnSync('tar', ['-xzf', tmp, '-C', BIN_DIR], { stdio: 'inherit' });
    rmSync(tmp, { force: true });
    if (out.status !== 0) throw new Error('kunde inte packa upp');
  } else {
    renameSync(tmp, bin);
  }
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  return bin;
}

/** cloudflared from PATH, from an earlier download, or downloaded now. */
export async function findCloudflared() {
  if (process.env.CLOUDFLARED && works(process.env.CLOUDFLARED)) return process.env.CLOUDFLARED;
  if (works('cloudflared')) return 'cloudflared';
  const asset = cloudflaredAsset();
  if (!asset) throw new Error(`cloudflared finns inte färdigt för ${process.platform}/${process.arch}`);
  const local = join(BIN_DIR, asset.bin);
  if (existsSync(local) && works(local)) return local;
  say('  Första gången: hämtar Cloudflares tunnelprogram (cloudflared, cirka 40 MB)…');
  return download(asset);
}

/**
 * Runs the quick tunnel; calls onUrl(url) once it carries traffic. Restarts
 * it (with a new address) if it stops.
 */
export function runTunnel(bin, port, { onUrl, onDown }) {
  let child = null;
  let stopped = false;
  let failures = 0;
  const start = () => {
    let url = null;
    let ready = false;
    let fallback = null;
    const tail = [];
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const announce = () => {
      if (ready || !url) return;
      ready = true;
      failures = 0;
      onUrl(url);
    };
    const read = (data) => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 12) tail.shift();
        url ??= tunnelUrl(line);
        // The address works once the first connection to Cloudflare is up.
        if (url && /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(line)) announce();
      }
      // Some versions log the registration differently: don't wait forever.
      if (url && !ready && !fallback) fallback = setTimeout(announce, 6000);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => tail.push(err.message));
    child.on('exit', (code) => {
      clearTimeout(fallback);
      // Ctrl+C reaches cloudflared too, a moment before our own handler: wait
      // a little so shutting down isn't reported as the tunnel failing.
      setTimeout(() => {
        if (stopped) return;
        failures++;
        const wait = Math.min(60, 5 * 2 ** Math.min(failures - 1, 4));
        onDown({ code, tail, everReady: ready, failures, wait });
        setTimeout(() => {
          if (!stopped) start();
        }, wait * 1000);
      }, 500);
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}

// --- The server list ---------------------------------------------------------------------

const HOST_FILE = join(root, 'server-data', 'host.json');
export const HEARTBEAT_MS = 2 * 60 * 1000;

/** This computer's server identity: its join code and the secret that proves it owns it. */
export function loadHost() {
  let host = {};
  try {
    host = JSON.parse(readFileSync(HOST_FILE, 'utf8'));
  } catch {
    // first time
  }
  if (typeof host.secret !== 'string' || host.secret.length < 32) host.secret = randomBytes(32).toString('base64url');
  return host;
}

export function saveHost(host) {
  mkdirSync(dirname(HOST_FILE), { recursive: true });
  writeFileSync(HOST_FILE, `${JSON.stringify(host, null, 2)}\n`);
}

/** Registers (or refreshes) the server in the list; returns its code. */
export async function registerServer({ supabaseUrl, key, url, host, listed, action = 'register', fetchFn = fetch }) {
  const res = await fetchFn(`${supabaseUrl.replace(/\/+$/, '')}/functions/v1/game-servers`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ action, url, secret: host.secret, code: host.code ?? undefined, listed: Boolean(listed) }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error ?? `serverlistan svarade ${res.status}`);
  return body.code ?? host.code;
}

// --- Main -------------------------------------------------------------------------------

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    say('', `  Servern behöver Node.js 22 eller nyare (du har ${process.versions.node}).`, '  Hämta den på https://nodejs.org (LTS) och kör sedan npm run share igen.', '');
    process.exit(1);
  }
  const port = Number(arg('port', process.env.PORT ?? 8787));
  const tunnel = !process.argv.includes('--no-tunnel');
  process.env.ALLOW_GUESTS ??= '1';
  if (arg('name')) process.env.SERVER_NAME = arg('name');

  let startServer;
  try {
    ({ startServer } = await import('../server/index.js'));
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      say('', '  Kör först: npm install', '');
      process.exit(1);
    }
    throw err;
  }

  let server;
  try {
    server = await startServer({
      port,
      // Only this computer and the tunnel reach the server (so the tunnel's
      // address headers can be trusted, and the router stays closed).
      host: '127.0.0.1',
      serveStatic: true,
      trustProxy: true,
      localAdmin: true,
      backupDir: process.env.BACKUP_DIR ?? 'server-data/backups',
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      say('', `  Port ${port} används redan. Kör du redan servern i ett annat fönster?`, `  Stäng den, eller välj en annan port: npm run share -- --port ${port + 1}`, '');
      process.exit(1);
    }
    throw err;
  }
  const local = `http://localhost:${server.port}`;

  let tun = null;
  const stopHooks = [];
  const stop = async (sig) => {
    say('', `  Stänger (${sig}): sparar alla spelare…`);
    await Promise.all(stopHooks.map((fn) => fn()));
    tun?.stop();
    await server.stop();
    say('  Klart. Välkommen tillbaka!');
    process.exit(0);
  };
  process.on('SIGINT', () => stop('Ctrl+C'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[fatal]', err);
    server.gs.saveAll();
  });

  if (!tunnel) {
    box(['Pixelgame-servern är igång (bara på den här datorn)', '', `Spela:      ${local}   (du är admin)`, 'Stäng av:   Ctrl+C (allt sparas)']);
    return;
  }

  let bin;
  try {
    bin = await findCloudflared();
  } catch (err) {
    say('', `  Kunde inte hämta cloudflared: ${err.message}`,
      '  Installera det själv och kör npm run share igen:',
      '    Windows:  winget install --id Cloudflare.cloudflared',
      '    macOS:    brew install cloudflared',
      '    Linux:    https://github.com/cloudflare/cloudflared/releases',
      '', `  Servern körs ändå, på den här datorn: ${local}`, '');
    return;
  }
  // The game's server list, if this copy of the game has one.
  const { CONFIG } = await import('../src/config.js');
  const mp = CONFIG.mp ?? {};
  const registry = mp.supabaseUrl && mp.supabaseAnonKey ? { supabaseUrl: mp.supabaseUrl, key: mp.supabaseAnonKey } : null;
  const site = (mp.siteUrl ?? '').replace(/\/+$/, '');
  const listed = process.argv.includes('--public');
  const host = loadHost();
  let current = null;
  let warned = false;
  const publish = async (url) => {
    if (!registry) return null;
    try {
      const code = await registerServer({ ...registry, url, host, listed });
      if (code !== host.code) {
        host.code = code;
        saveHost(host);
      }
      warned = false;
      return code;
    } catch (err) {
      if (!warned) say('', `  Serverlistan svarade inte (${err.message}). Vännerna kan använda länken direkt.`);
      warned = true;
      return null;
    }
  };
  const heartbeat = setInterval(() => current && publish(current), HEARTBEAT_MS);
  heartbeat.unref();
  const goOffline = async () => {
    clearInterval(heartbeat);
    if (!registry || !host.code) return;
    await registerServer({ ...registry, url: current, host, listed, action: 'offline' }).catch(() => {});
  };
  stopHooks.push(goOffline);

  say('  Startar tunneln till Cloudflare…');
  tun = runTunnel(bin, server.port, {
    async onUrl(url) {
      current = url;
      const code = await publish(url);
      if (code) {
        box([
          'Pixelgame är igång!',
          '',
          `Serverns kod:           ${code}`,
          `Skicka länken:          ${site}/?join=${code}`,
          `Spela själv (admin):    ${local}`,
          '',
          'Vännerna öppnar länken, eller skriver koden under Multiplayer',
          `på ${site.replace(/^https?:\/\//, '')}. Koden är densamma nästa gång.`,
          listed ? 'Servern syns också i listan för alla.' : 'Bara den som har koden hittar servern (--public visar den för alla).',
          '',
          'Stäng av: Ctrl+C (allt sparas). Datorn måste vara på medan ni spelar.',
        ]);
        return;
      }
      box([
        'Pixelgame är igång!',
        '',
        `Skicka till dina vänner:   ${url}`,
        `Spela själv (admin):       ${local}`,
        '',
        'Vännerna: öppna länken → Multiplayer → Spela som gäst.',
        'Länken byts varje gång du startar. Har man spelat förut:',
        'Multiplayer → Logga in med namn (och lösenordet man valde).',
        '',
        'Stäng av: Ctrl+C (allt sparas). Datorn måste vara på medan ni spelar.',
      ]);
    },
    onDown({ code, tail, everReady, failures, wait }) {
      if (everReady) say('', `  Tunneln stängdes (kod ${code}). Startar en ny om ${wait} s. Den får en ny adress.`);
      else say('', `  Tunneln startade inte (kod ${code}). Försöker igen om ${wait} s.`);
      if (!everReady && (failures === 2 || failures % 5 === 0)) {
        say('  Senaste raderna från cloudflared:', ...tail.slice(-3).map((l) => `    ${l.slice(0, 160)}`),
          '  Kontrollera internetanslutningen. En brandvägg som stoppar port 7844 stoppar också tunneln.',
          `  Spelet fungerar ändå på den här datorn: ${local}`);
      }
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
