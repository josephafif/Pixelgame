#!/usr/bin/env node
// npm run share: multiplayer from your own computer, free, in one step.
//
// Starts the game server (it also serves the game itself) and a Cloudflare
// quick tunnel, which gives this computer a public https:// address. It needs
// no account, no card and no router settings. Send the address to your
// friends: they open it and press Multiplayer.
//
//  - The address changes every time you start. Players choose a password
//    with their name, and log in with it on the new address.
//  - You play at http://localhost:8787 and are admin there (/help in the chat).
//  - Everything is saved in server-data/pixelgame.db. Ctrl+C saves and stops.
//
// cloudflared (Cloudflare's tunnel program) is used if it is installed.
// Otherwise it is downloaded once, from Cloudflare's releases on GitHub,
// into server-data/bin/.
//
// Options: --port 8787   --name "Our server"   --no-tunnel (only this computer)

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
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
async function findCloudflared() {
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
function runTunnel(bin, port, { onUrl, onDown }) {
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
  const stop = async (sig) => {
    say('', `  Stänger (${sig}): sparar alla spelare…`);
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
  say('  Startar tunneln till Cloudflare…');
  tun = runTunnel(bin, server.port, {
    onUrl(url) {
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
