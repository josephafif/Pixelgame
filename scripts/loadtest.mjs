#!/usr/bin/env node
// Load test: N bots walk and fight out in the wild for a while.
//   node scripts/loadtest.mjs [--bots 50] [--seconds 30] [--url ws://host:8787/ws]
// Without --url it starts its own server (in memory) and reports the tick time.

import { Bot, sleep } from '../tests/mp/bot.js';
import { BTN } from '../src/net/protocol.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const N = Number(arg('bots', 50));
// Fresh names every run (a server keeps the characters of earlier runs).
const RUN = Math.floor(Math.random() * 1e4);
const SECONDS = Number(arg('seconds', 30));
let url = arg('url', null);
let srv = null;
if (!url) {
  const { startServer } = await import('../server/index.js');
  srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, devAdmins: true, maxPerIp: 1000, log: { info() {}, debug() {}, warn() {}, error: console.error } });
  url = `ws://127.0.0.1:${srv.port}/ws`;
}
console.log(`${N} bots for ${SECONDS}s against ${url}`);
const bots = [];
for (let i = 0; i < N; i++) {
  bots.push(await new Bot(url, { name: `L${RUN}_${i}` }).connect());
}
// Spread them over a few groups out in the wild (where the monsters are).
for (const [i, b] of bots.entries()) {
  const group = i % 5;
  b.send({ t: 'chat', text: `/tp ${80 + group * 40} ${(group % 2) * 40}` });
}
await sleep(500);
const start = Date.now();
const bytes0 = bots.reduce((s, b) => s + (b.bytes ?? 0), 0);
const timers = bots.map((b) => {
  let dir = Math.random() * Math.PI * 2;
  return setInterval(() => {
    if (Math.random() < 0.05) dir = Math.random() * Math.PI * 2;
    b.input({ mx: Math.round(Math.cos(dir) * 127), my: Math.round(Math.sin(dir) * 127), buttons: Math.random() < 0.5 ? BTN.ATTACK : 0, aim: Math.floor(Math.random() * 256) });
  }, 33);
});
let maxTick = 0;
const samples = [];
const poll = setInterval(() => {
  if (srv) {
    samples.push(srv.gs.stats.tickMs);
    maxTick = Math.max(maxTick, srv.gs.stats.maxTickMs);
  }
}, 1000);
await sleep(SECONDS * 1000);
timers.forEach(clearInterval);
clearInterval(poll);
const secs = (Date.now() - start) / 1000;
const snaps = bots.reduce((s, b) => s + b.snapshots, 0) / N / secs;
console.log(`snapshots/s per bot: ${snaps.toFixed(1)} (target 30)`);
if (srv) {
  const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  console.log(`server tick: avg ${avg.toFixed(2)} ms, max ${maxTick.toFixed(2)} ms (budget 33 ms) · enemies ${srv.gs.enemies.size} · projectiles ${srv.gs.projectiles.size}`);
  console.log(`sent: ${(srv.gs.stats.sent / 1024 / secs / N).toFixed(1)} kB/s per player (binary snapshots)`);
}
void bytes0;
for (const b of bots) b.close();
await sleep(300);
await srv?.stop();
process.exit(0);
