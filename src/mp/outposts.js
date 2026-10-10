// Outposts on the multiplayer client. The world says where every outpost
// stands and how it is built, so its palisade and flag are placed here
// exactly as the server places them (territory.js: placeOutpost). Who holds
// each square comes from the server ({ t: 'terr' }); the flag takes the
// holder's colour.

import { territoryAt, outpostFor, placeOutpost, removeOutpost, outpostDormant } from '../game/territory.js';

const ACTIVATE = 70;
const DEACTIVATE = 92;
const NEUTRAL = '#b8b8c8';

export class MpOutposts {
  constructor(game) {
    this.game = game;
    this.active = new Map(); // key → { site, structures }
    this.structures = [];
    this.squares = new Map(); // key → { owner, tag, color, cap, by, att } (only squares someone holds or is taking)
    this.checkT = 0;
  }

  /** { t: 'terr', list } from the server. */
  setSquares(list) {
    this.squares = new Map(list.map((e) => [e.key, e]));
    for (const [key, entry] of this.active) {
      const color = this.colorOf(key);
      for (const st of entry.structures) st.color = color;
    }
  }

  colorOf(key) {
    return this.squares.get(key)?.color ?? NEUTRAL;
  }

  update(dt) {
    const g = this.game;
    if (!g.world) return;
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
        this.active.set(site.key, { site, structures: placeOutpost(g.world, g.data, site, this.colorOf(site.key)) });
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
  }

  #refresh() {
    this.structures = [...this.active.values()].flatMap((e) => e.structures);
  }
}
