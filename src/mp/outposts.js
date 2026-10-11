// Outposts on the multiplayer client. The world says where every outpost
// stands and how it is built, so its palisade and flag are placed here
// exactly as the server places them (territory.js: placeOutpost). Who holds
// each territory comes from the server ({ t: 'terr' }): a clan, or an NPC
// faction (owner 'f:<id>', with its base's tier: a faction's stronghold has
// towers, its headquarters stone ramparts). The flag takes the holder's
// colour. The message also brings the factions and their armies on the
// march, for the strategy map.

import { territoryAt, outpostFor, placeOutpost, removeOutpost, outpostDormant, regionAt } from '../game/territory.js';
import { isFactionRef, factionIdOf, genitiveSv } from '../game/factions.js';

const ACTIVATE = 70;
const DEACTIVATE = 92;
const NEUTRAL = '#b8b8c8';

export class MpOutposts {
  constructor(game) {
    this.game = game;
    this.active = new Map(); // key → { site, structures, tier }
    this.structures = [];
    this.squares = new Map(); // key → { owner, tag, color, cap, by, att, base } (only territories someone holds or is taking)
    this.factions = []; // [{ id, name, color, personality, quality, alive, squares, at }]
    this.armies = []; // [{ id, f, x, y, to, toX, toY, troops }]
    this.checkT = 0;
    this.landOwner = undefined;
  }

  /** { t: 'terr', list, factions, armies } from the server; true if who holds what changed. */
  setSquares(list, { factions = null, armies = null } = {}) {
    const sig = (m) => [...m.values()].map((e) => `${e.key}|${e.owner}|${e.base ?? ''}|${e.att}`).sort().join(';');
    const before = sig(this.squares);
    this.squares = new Map(list.map((e) => [e.key, e]));
    if (factions) this.factions = factions;
    if (armies) this.armies = armies;
    for (const [key, entry] of this.active) {
      if (entry.tier !== this.tierOf(key)) {
        // A base that grew (or changed hands) is built anew.
        removeOutpost(this.game.world, entry.structures);
        this.active.delete(key);
        this.#place(entry.site);
        continue;
      }
      const color = this.colorOf(key);
      for (const st of entry.structures) st.color = color;
    }
    this.#refresh();
    return sig(this.squares) !== before;
  }

  colorOf(key) {
    return this.squares.get(key)?.color ?? NEUTRAL;
  }

  tierOf(key) {
    const sq = this.squares.get(key);
    return isFactionRef(sq?.owner) ? sq.base ?? 'camp' : 'camp';
  }

  factionById(id) {
    return this.factions.find((f) => f.id === id) ?? null;
  }

  update(dt) {
    const g = this.game;
    if (!g.world) return;
    for (const st of this.structures) if (st.rt?.flash > 0) st.rt.flash -= dt;
    this.checkT -= dt;
    if (this.checkT > 0) return;
    this.checkT = 0.5;
    const p = g.player;
    const { tx, ty } = territoryAt(g.data, p.x, p.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const site = outpostFor(g.world, g.data, tx + dx, ty + dy);
        if (!site || this.active.has(site.key) || (site.x - p.x) ** 2 + (site.y - p.y) ** 2 > ACTIVATE * ACTIVATE) continue;
        if (outpostDormant(site, g.claims, g.rules?.claimRadius ?? 16)) continue;
        this.#place(site);
        this.#refresh();
      }
    }
    for (const [key, entry] of this.active) {
      const near = (entry.site.x - p.x) ** 2 + (entry.site.y - p.y) ** 2 < DEACTIVATE * DEACTIVATE;
      if (near && !outpostDormant(entry.site, g.claims, g.rules?.claimRadius ?? 16)) continue;
      removeOutpost(g.world, entry.structures);
      this.active.delete(key);
      this.#refresh();
    }
    this.#landHere();
  }

  #place(site) {
    const tier = this.tierOf(site.key);
    this.active.set(site.key, { site, tier, structures: placeOutpost(this.game.world, this.game.data, site, this.colorOf(site.key), tier) });
  }

  /** Stepping onto a faction's land is worth a word. */
  #landHere() {
    const g = this.game;
    const region = regionAt(g.world, g.data, g.player.x, g.player.y);
    const owner = region && !region.home ? this.squares.get(region.key)?.owner ?? null : null;
    const fid = isFactionRef(owner) ? factionIdOf(owner) : null;
    if (fid === this.landOwner) return;
    const before = this.landOwner;
    this.landOwner = fid;
    if (before === undefined || !fid) return;
    const f = this.factionById(fid);
    const base = this.squares.get(region.key)?.base;
    g.toast(`Ni går in på ${f ? genitiveSv(f.name) : 'en fraktions'} mark${base === 'hq' ? ', vid deras högkvarter' : ''}. Deras trupper vaktar den.`, 'warn');
  }

  #refresh() {
    this.structures = [...this.active.values()].flatMap((e) => e.structures);
  }
}
