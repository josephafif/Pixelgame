// Builds one game world with its login and HTTP API from the game data, a
// database and the configuration. Used by the Node server (index.js) and the
// Cloudflare Durable Object (cloud/worker.js) alike.

import { prepareGameData } from '../src/data/gamedata.js';
import { mpGameData } from '../src/net/mpbuild.js';
import { Auth } from './auth.js';
import { GameServer } from './game-server.js';
import { createApi } from './http-api.js';

export function setupGame({ raw, db, config, log, fetch }) {
  const data = mpGameData(prepareGameData(raw));
  const auth = new Auth({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    supabaseJwtSecret: config.supabaseJwtSecret,
    allowGuests: config.allowGuests,
    guestSecret: config.guestSecret ?? null,
    fetch,
  });
  const gs = new GameServer({ data, db, config, log });
  // Guest tokens must survive restarts (or guests would lose their character).
  auth.guestSecret = config.guestSecret || db.meta('guestSecret');
  const api = createApi(gs, auth, config, log);
  return { gs, auth, api };
}
