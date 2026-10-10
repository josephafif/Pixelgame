// Server configuration from environment variables (see server/.env.example).

import { DEFAULT_RULES, parseRaidWindow } from '../src/net/rules.js';

// The environment to read (process.env on a normal server, the Worker's
// variables on Cloudflare).
let env = {};

function num(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function bool(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function list(name) {
  return (env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(overrides = {}, source = globalThis.process?.env ?? {}) {
  env = source;
  const rules = {
    ...DEFAULT_RULES,
    safeRadius: num('RULE_SAFE_RADIUS', DEFAULT_RULES.safeRadius),
    claimRadius: num('RULE_CLAIM_RADIUS', DEFAULT_RULES.claimRadius),
    claimMinDistance: num('RULE_CLAIM_MIN_DISTANCE', DEFAULT_RULES.claimMinDistance),
    clanMax: num('RULE_CLAN_MAX', DEFAULT_RULES.clanMax),
    raidGraceMinutes: num('RULE_RAID_GRACE_MINUTES', DEFAULT_RULES.raidGraceMinutes),
    raidWindow: env.RULE_RAID_WINDOW ?? DEFAULT_RULES.raidWindow,
    timezone: env.RULE_TIMEZONE || DEFAULT_RULES.timezone,
    vaultProtected: num('RULE_VAULT_PROTECTED', DEFAULT_RULES.vaultProtected),
    deathDrop: num('RULE_DEATH_DROP', DEFAULT_RULES.deathDrop),
    hardcore: bool('RULE_HARDCORE', DEFAULT_RULES.hardcore),
    newbieSeconds: num('RULE_NEWBIE_HOURS', DEFAULT_RULES.newbieSeconds / 3600) * 3600,
    ...(overrides.rules ?? {}),
  };
  parseRaidWindow(rules.raidWindow); // fail fast on a typo
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const config = {
    port: num('PORT', 8787),
    host: env.HOST || '0.0.0.0',
    serverName: env.SERVER_NAME || 'Pixelgame-servern',
    dbPath: env.DB_PATH || 'server-data/pixelgame.db',
    maxPlayers: num('MAX_PLAYERS', 50),
    // Connections from one address (a household shares one).
    maxPerIp: num('MAX_PER_IP', 8),
    // Allowed browser origins for the WebSocket (empty = any; set this in production).
    origins: list('ALLOWED_ORIGINS'),
    // Login: Supabase (recommended) and/or guests (local testing, friends' trial).
    supabaseUrl,
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? '',
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET ?? '',
    allowGuests: bool('ALLOW_GUESTS', !supabaseUrl),
    // Accounts (Supabase user id or guest id) or e-mails with admin commands.
    admins: list('ADMINS'),
    // Fixed world seed (default: random on first start, then kept in the database).
    worldSeed: env.WORLD_SEED ? Number(env.WORLD_SEED) >>> 0 : null,
    saveIntervalMs: num('SAVE_INTERVAL_MS', 10000),
    // How many 30 Hz input frames a client packs into one message (1 = every
    // tick). Cloudflare counts incoming messages, so the official server uses 2.
    inputEvery: Math.min(4, Math.max(1, Math.round(num('INPUT_EVERY', 1)))),
    // Charge base upkeep for the hours the world was asleep (Cloudflare: the
    // world sleeps whenever nobody plays, but its time goes on).
    upkeepCatchUp: bool('UPKEEP_CATCH_UP', false),
    maxEnemies: num('MAX_ENEMIES', 500),
    // Territories' outposts and their guards (server/army.js).
    outposts: bool('OUTPOSTS', true),
    logLevel: env.LOG_LEVEL || 'info',
    ...overrides,
    rules,
  };
  return config;
}
