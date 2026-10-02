// Multiplayer rules as pure functions, shared by the server (which enforces
// them) and the client (which explains them). Every number here can be
// changed per server (server/config.js → `rules`).

export const DEFAULT_RULES = {
  // Fristaden: the safe town at the centre of the world (no PvP, no building).
  safeRadius: 24,
  // A clan banner claims a circle of ground for the clan.
  claimRadius: 16,
  // Banners stand at least this far from the town centre and from each other.
  claimMinDistance: 40,
  clanMax: 8,
  // A base can be raided while someone in the clan is online, and for this
  // many minutes after the last one logs out (no logging out to dodge a raid).
  raidGraceMinutes: 15,
  // Plus a weekly window when every base can be raided ('' = none).
  raidWindow: 'sat 18:00-21:00',
  timezone: 'Europe/Stockholm',
  // Part of a clan vault that raiders can never take.
  vaultProtected: 0.5,
  // Part of the resources you carry that you drop when you die in the wild.
  deathDrop: 0.5,
  // Hardcore servers: weapons you carry (but don't hold) drop too.
  hardcore: false,
  // New players are protected until they have played this long or beaten a boss.
  newbieSeconds: 2 * 60 * 60,
  spawnProtectSeconds: 10,
  // Logging out in the wild leaves your body for this long.
  sleepSeconds: 30,
  // Weekly banner upkeep per structure in the claim (paid from the vault).
  upkeepPerStructure: { wood: 0.5, stone: 0.5 },
  // Bosses: you get loot if you did at least this share of the damage.
  bossShare: 0.1,
  // Weapons are tuned for monsters; against players they hit softer, so a
  // fight lasts long enough to react.
  pvpDamage: 0.6,
  // Weapons and turrets wear down walls this much slower than monsters.
  structureDamage: 0.5,
};

export function inSafeZone(rules, x, y) {
  return x * x + y * y < rules.safeRadius * rules.safeRadius;
}

// --- Raid window -----------------------------------------------------------------

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAMES_SV = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];

/** "sat 18:00-21:00, sun 18:00-21:00" → [{ day, start, end }] (minutes). */
export function parseRaidWindow(spec) {
  if (!spec || /^(off|none|-)$/i.test(spec.trim())) return [];
  const out = [];
  for (const part of spec.split(',')) {
    const m = part.trim().toLowerCase().match(/^(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) throw new Error(`Bad raid window "${part.trim()}" (example: sat 18:00-21:00)`);
    const start = Number(m[2]) * 60 + Number(m[3]);
    const end = Number(m[4]) * 60 + Number(m[5]);
    if (start >= 24 * 60 || end > 24 * 60 || end <= start) throw new Error(`Bad raid window times "${part.trim()}"`);
    out.push({ day: DAYS[m[1]], start, end });
  }
  return out;
}

/** Weekday (0 = Sunday) and minute of the day at `date` in `timeZone`. */
export function localTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: DAYS[get('weekday').toLowerCase().slice(0, 3)], minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function inRaidWindow(windows, date, timeZone) {
  if (!windows.length) return false;
  const { day, minutes } = localTimeParts(date, timeZone);
  return windows.some((w) => w.day === day && minutes >= w.start && minutes < w.end);
}

/** "lördag 18:00–21:00" for the UI. */
export function describeRaidWindow(windows) {
  if (!windows.length) return 'inget raidfönster';
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return windows.map((w) => `${DAY_NAMES_SV[w.day]} ${hm(w.start)}–${hm(w.end)}`).join(', ');
}

/**
 * Can other players damage this clan's base right now?
 * clan: { online: number of members online, lastOnlineAt: ms or 0 }.
 */
export function raidState(rules, clan, now, windows = parseRaidWindow(rules.raidWindow)) {
  if (clan.online > 0) return { raidable: true, reason: 'online' };
  if (clan.lastOnlineAt && now - clan.lastOnlineAt < rules.raidGraceMinutes * 60 * 1000) {
    return { raidable: true, reason: 'grace', until: clan.lastOnlineAt + rules.raidGraceMinutes * 60 * 1000 };
  }
  if (inRaidWindow(windows, new Date(now), rules.timezone)) return { raidable: true, reason: 'window' };
  return { raidable: false, reason: 'offline' };
}

// --- PvP ---------------------------------------------------------------------------

/** Is this player still protected as a newcomer? */
export function isNewbie(rules, ch) {
  return !ch.pvpOptIn && !ch.firstBoss && (ch.playSeconds ?? 0) < rules.newbieSeconds;
}

/**
 * Why `attacker` may not hurt `victim` (null = it may). Players are
 * { x, y, clanId, dead, newbie, protectUntil, asleep }.
 */
export function pvpBlock(rules, attacker, victim, now) {
  if (attacker === victim) return 'self';
  if (attacker.dead || victim.dead) return 'dead';
  if (attacker.clanId && attacker.clanId === victim.clanId) return 'clan';
  if (inSafeZone(rules, attacker.x, attacker.y) || inSafeZone(rules, victim.x, victim.y)) return 'safe';
  if (victim.protectUntil > now) return 'spawn';
  if (victim.newbie && !victim.asleep) return 'newbie';
  return null;
}

// --- Clans -------------------------------------------------------------------------

export const ROLES = ['member', 'officer', 'leader'];
export const ROLE_SV = { member: 'Medlem', officer: 'Officer', leader: 'Ledare' };

const PERMS = {
  build: 'member',
  deposit: 'member',
  invite: 'officer',
  kick: 'officer',
  withdraw: 'officer',
  unbuild: 'officer',
  banner: 'officer',
  promote: 'leader',
  demote: 'leader',
  disband: 'leader',
  transfer: 'leader',
};

export function canDo(role, action) {
  const need = PERMS[action];
  if (!need) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(need);
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,14}[\p{L}\p{N}]$/u;

export function playerNameProblem(name) {
  if (typeof name !== 'string') return 'Ange ett namn';
  if (name.length < 3 || name.length > 16) return 'Namnet ska vara 3–16 tecken';
  if (!NAME_RE.test(name)) return 'Bara bokstäver, siffror, mellanslag, - och _';
  if (/\s{2,}/.test(name)) return 'Inga dubbla mellanslag';
  return null;
}

/** Password for logging in with your name (guest servers). */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 4) return 'Lösenordet ska vara minst 4 tecken';
  if (pw.length > 64) return 'Lösenordet får vara högst 64 tecken';
  return null;
}

export function clanNameProblem(name) {
  if (typeof name !== 'string' || name.length < 3 || name.length > 20) return 'Klannamnet ska vara 3–20 tecken';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '_-]*[\p{L}\p{N}]$/u.test(name) || /\s{2,}/.test(name)) return 'Bara bokstäver, siffror och mellanslag';
  return null;
}

export function clanTagProblem(tag) {
  if (typeof tag !== 'string' || !/^[A-ZÅÄÖ0-9]{2,4}$/.test(tag)) return 'Taggen ska vara 2–4 versaler eller siffror';
  return null;
}

/** Where a banner may not stand (null = fine). claims: [{ x, y, clanId }]. */
export function bannerProblem(rules, x, y, clanId, claims) {
  if (Math.sqrt(x * x + y * y) < rules.claimMinDistance) return `För nära Fristaden (minst ${rules.claimMinDistance} rutor från mitten)`;
  for (const c of claims) {
    if (c.clanId === clanId) continue;
    const d = Math.sqrt((c.x - x) ** 2 + (c.y - y) ** 2);
    if (d < rules.claimMinDistance) return 'För nära en annan klans bas';
  }
  return null;
}

/** The claim containing tile (tx, ty), or null. */
export function claimAt(rules, claims, tx, ty) {
  const r2 = rules.claimRadius * rules.claimRadius;
  for (const c of claims) {
    const dx = tx + 0.5 - c.x;
    const dy = ty + 0.5 - c.y;
    if (dx * dx + dy * dy <= r2) return c;
  }
  return null;
}
