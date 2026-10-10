// Upkeep: what keeping a base running costs, and how long the vault's
// supplies last. Walls and the rest of what you built, the camp's buildings
// and every hired worker each cost a little every day; it is paid from the
// vault once an hour. Shared by single player (the camp's Vault, rates in
// gamedata.json → base.upkeep / base.workers) and multiplayer (the clan
// vault, rates in the server's rules).

export const UPKEEP_KEYS = ['wood', 'stone', 'scrap', 'essence'];
export const HOUR_MS = 3600 * 1000;

function add(out, rates, n) {
  for (const [k, v] of Object.entries(rates ?? {})) {
    if (v && n) out[k] = (out[k] ?? 0) + v * n;
  }
  return out;
}

/**
 * Upkeep per day, by what causes it. counts: { structures, buildingLevels,
 * workers }; rates (per day each): { perStructure, perBuildingLevel,
 * perWorker }. Returns { structures, buildings, workers, total }, each a
 * { resource: amount } map.
 */
export function upkeepPerDay(counts, rates) {
  const structures = add({}, rates.perStructure, counts.structures ?? 0);
  const buildings = add({}, rates.perBuildingLevel, counts.buildingLevels ?? 0);
  const workers = add({}, rates.perWorker, counts.workers ?? 0);
  // Soldiers draw their own pay (more than a worker's).
  const soldiers = add({}, rates.perSoldier ?? rates.perWorker, counts.soldiers ?? 0);
  const total = {};
  for (const part of [structures, buildings, workers, soldiers]) add(total, part, 1);
  return { structures, buildings, workers, soldiers, total };
}

/** Hours the supplies in `vault` keep the base running (Infinity when nothing is due). */
export function suppliesLast(vault, perDay) {
  let hours = Infinity;
  for (const [k, v] of Object.entries(perDay)) {
    if (v > 0) hours = Math.min(hours, (Math.max(0, vault[k] ?? 0) / v) * 24);
  }
  return hours;
}

/** The resource that runs out first, or null. */
export function firstToRunOut(vault, perDay) {
  let best = null;
  let hours = Infinity;
  for (const [k, v] of Object.entries(perDay)) {
    if (v <= 0) continue;
    const h = Math.max(0, vault[k] ?? 0) / v;
    if (h < hours) {
      hours = h;
      best = k;
    }
  }
  return best;
}

/** "3 d 4 h", "5 h 20 min", "12 min" (Swedish: "3 d 4 tim", "5 tim 20 min"). */
export function formatHours(hours, lang = 'en') {
  const h = lang === 'sv' ? 'tim' : 'h';
  if (!Number.isFinite(hours)) return lang === 'sv' ? 'för alltid' : 'forever';
  if (hours <= 0) return lang === 'sv' ? 'slut nu' : 'empty';
  const minutes = Math.floor(hours * 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const days = Math.floor(minutes / (24 * 60));
  const hh = Math.floor((minutes % (24 * 60)) / 60);
  if (days >= 100) return lang === 'sv' ? 'mer än 100 dygn' : '100+ days';
  if (days > 0) return hh ? `${days} d ${hh} ${h}` : `${days} d`;
  const mm = minutes % 60;
  return mm ? `${hh} ${h} ${mm} min` : `${hh} ${h}`;
}

/**
 * Charges `hours` of upkeep. What is due collects in `owed` (fractions
 * carry over to the next hour) and whole units are paid from `wallets`, in
 * order (the vault first). A debt never grows past one day's upkeep.
 * Returns true when everything due was paid.
 */
export function chargeUpkeep(perDay, hours, owed, wallets) {
  let paid = true;
  for (const [k, v] of Object.entries(perDay)) {
    if (!(v > 0)) continue;
    owed[k] = Math.min(Math.max(1, v), (owed[k] ?? 0) + (v * hours) / 24);
    let due = Math.floor(owed[k]);
    for (const w of wallets) {
      if (due <= 0) break;
      const take = Math.min(Math.floor(w[k] ?? 0), due);
      if (take > 0) {
        w[k] -= take;
        owed[k] -= take;
        due -= take;
      }
    }
    if (due > 0) paid = false;
  }
  return paid;
}

/** Rounds a per-day map for display ({ wood: 4.2 } → { wood: 5 }). */
export function roundUp(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) if (v > 0) out[k] = Math.ceil(v - 1e-9);
  return out;
}
