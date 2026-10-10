// The fen's plants, which burst when anything hits them: a Mendbloom opens
// into a healing glow, a Puffcap into a poison cloud that hurts whoever
// stands in it (monsters most of all: lure them in and pop it). They grow
// back in a few minutes. Shared by single player and the server.

import { T, PLANTS } from './world.js';

export const PLANT_AREAS = {
  [T.MENDBLOOM]: { kind: 'mend', r: 2.2, dur: 4, healPct: 6, color: '#9affc8' },
  [T.PUFFCAP]: { kind: 'puff', r: 2.1, dur: 4, color: '#b8d84a' },
};

/** A Puffcap's cloud: damage per second to monsters (players take half). */
export function puffDps(worldLevel) {
  return 6 + worldLevel * 2.5;
}

/**
 * The plant tiles an attack touches: [{ tx, ty, id }]. `inside(x, y, r)`
 * says whether a circle is inside the attack's shape.
 */
export function plantsHit(world, x, y, reach, inside) {
  const out = [];
  const r = Math.ceil(reach + 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  for (let ty = y0 - r; ty <= y0 + r; ty++) {
    for (let tx = x0 - r; tx <= x0 + r; tx++) {
      const id = world.blockAt(tx, ty);
      if (PLANTS.has(id) && inside(tx + 0.5, ty + 0.5, 0.35)) out.push({ tx, ty, id });
    }
  }
  return out;
}
