// Starts a real game server (in-memory database) for tests.

import { startServer } from '../../server/index.js';
import { Bot, sleep } from './bot.js';

const quiet = { info() {}, debug() {}, warn() {}, error: (...a) => console.error(...a) };

export async function testServer(overrides = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: ':memory:', allowGuests: true, log: quiet, ...overrides });
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
    async close() {
      for (const b of bots) b.ws.close();
      await sleep(50);
      await srv.stop();
    },
  };
}

export { sleep };
