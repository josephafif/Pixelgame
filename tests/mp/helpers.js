// Starts a real game server (in-memory database) for tests.

import { startServer } from '../../server/index.js';
import { Bot, sleep } from './bot.js';
import * as base from '../../server/base.js';
import { LIQUID } from '../../src/game/world.js';

/** Where a test base goes: dry ground away from town and markets (trees and rocks there are cut down). */
export function clearArea(gs, x0 = 110, y0 = 0.5, r = 6) {
  const w = gs.world;
  for (let ring = 0; ring < 60; ring++) {
    for (let k = 0; k < Math.max(1, ring * 6); k++) {
      const a = (k / Math.max(1, ring * 6)) * Math.PI * 2;
      const cx = Math.floor(x0 + Math.cos(a) * ring * 3);
      const cy = Math.floor(y0 + Math.sin(a) * ring * 3);
      if (Math.hypot(cx, cy) < gs.rules.claimMinDistance + 4) continue;
      if (w.marketAt(cx + 0.5, cy + 0.5, 30)) continue;
      if (gs.claims().some((c) => Math.hypot(c.x - cx, c.y - cy) < gs.rules.claimMinDistance)) continue;
      let ok = true;
      for (let dy = -r; dy <= r && ok; dy++) {
        for (let dx = -r; dx <= r && ok; dx++) {
          if (LIQUID.has(w.blockAt(cx + dx, cy + dy)) || w.structureAt(cx + dx, cy + dy)) ok = false;
        }
      }
      if (!ok) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) if (w.blockAt(cx + dx, cy + dy)) w.removeBlock(cx + dx, cy + dy);
      }
      return { x: cx, y: cy };
    }
  }
  throw new Error('no clear ground for a test base');
}

// Spots for the camp buildings around a banner (2+ tiles apart, within reach of the middle).
const SPOTS = { hearth: [-4, -3], forge: [0, -4], vault: [4, -3], library: [-4, 1], training: [4, 1], well: [-3, 4], waystone: [1, 4], den: [4, 4], lodge: [-1, 6] };

const quiet = { info() {}, debug() {}, warn() {}, error: (...a) => console.error(...a) };

export async function testServer(overrides = {}) {
  // Outposts (and their guards) only where a test asks for them.
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, log: quiet, outposts: false, ...overrides });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const bots = [];
  return {
    srv,
    gs: srv.gs,
    url,
    async bot(name, opts = {}) {
      const b = await new Bot(url, { name, ...opts }).connect();
      bots.push(b);
      await sleep(80);
      return b;
    },
    /** The server-side player for a bot. */
    player(bot) {
      return srv.gs.players.get(bot.welcome.id);
    },
    /** Moves a player on the server (tests only). */
    place(bot, x, y) {
      const p = srv.gs.players.get(bot.welcome.id);
      const spot = srv.gs.world.findFreeSpot(x, y, p.r);
      p.x = spot.x;
      p.y = spot.y;
      p.queue.length = 0;
      return p;
    },
    /**
     * Gives a bot a clan with a base: a banner on clear ground and the camp
     * buildings asked for, at the given levels ({ forge: 3, waystone: 2 }).
     * The bot ends up standing in the middle of it.
     */
    async clanBase(bot, levels = {}, { name = 'Basfolket', tag = 'BAS', near = [110, 0.5] } = {}) {
      const gs = srv.gs;
      const p = gs.players.get(bot.welcome.id);
      let res = p.clanId ? { ok: true } : await bot.request({ t: 'clan', op: 'create', name, tag });
      if (!res.ok) throw new Error(res.error);
      const at = clearArea(gs, near[0], near[1]);
      p.x = at.x + 0.5;
      p.y = at.y + 2.5;
      p.queue.length = 0;
      p.ch.level = Math.max(p.ch.level, 30);
      const keep = { ...p.ch.resources };
      Object.assign(p.ch.resources, { wood: 99999, stone: 99999, scrap: 99999, essence: 99999 });
      res = await bot.request({ t: 'build', id: 'banner', x: at.x, y: at.y });
      if (!res.ok) throw new Error(`banner: ${res.error}`);
      const spots = {};
      for (const id of Object.keys(levels)) {
        const [dx, dy] = SPOTS[id];
        res = await bot.request({ t: 'build', id: `b_${id}`, x: at.x + dx, y: at.y + dy });
        if (!res.ok) throw new Error(`${id}: ${res.error}`);
        spots[id] = { x: at.x + dx, y: at.y + dy };
      }
      const clan = gs.clans.get(p.clanId);
      for (const [id, lv] of Object.entries(levels)) clan.base.buildings[id] = lv;
      base.changed(gs, clan);
      Object.assign(p.ch.resources, keep);
      return { clan, banner: at, spots };
    },
    /** Puts a bot right next to (below) one of its clan's buildings. */
    nextTo(bot, spot) {
      const p = srv.gs.players.get(bot.welcome.id);
      p.x = spot.x + 0.5;
      p.y = spot.y + 1.5;
      p.queue.length = 0;
      return p;
    },
    async close() {
      for (const b of bots) b.ws.close();
      await sleep(50);
      await srv.stop();
    },
  };
}

export { sleep };
