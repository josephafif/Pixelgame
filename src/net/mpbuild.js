// Building in multiplayer: the same structures as the single-player camp,
// plus the clan banner (which claims the land around it) and the camp's
// buildings (forge, vault … see mpbase.js). The camp's building-level
// requirements are replaced by character levels.

import { baseStructDefs } from './mpbase.js';

const MP_OVERRIDES = {
  banner: {
    name: 'Klanbanér',
    hp: 1500,
    desc: 'Gör anspråk på marken runt omkring åt din klan. Bara klanen kan bygga där.',
    mpLevel: 1,
  },
  wood_wall: { mpLevel: 1, name: 'Trävägg', desc: 'Stoppar monster. Billig och snabb.' },
  stone_wall: { mpLevel: 4, name: 'Stenmur', desc: 'Stadig mur som håller mycket längre.' },
  gate: { mpLevel: 2, name: 'Grind', desc: 'Öppnas bara för din klan.' },
  arrow_turret: { mpLevel: 6, name: 'Piltorn', desc: 'Skjuter pilar på monster och inkräktare.' },
  flame_turret: { mpLevel: 12, name: 'Eldtorn', desc: 'Kastar eld som sätter fienden i brand.' },
  spikes: { mpLevel: 3, name: 'Spikfälla', desc: 'Skadar monster och inkräktare som kliver på den.' },
  torch: { mpLevel: 1, name: 'Fackla', desc: 'Lyser upp basen.' },
  wood_floor: { mpLevel: 1, name: 'Trägolv', desc: 'Plankor att gå på.' },
  stone_floor: { mpLevel: 1, name: 'Stengång', desc: 'Stenlagd gång.' },
};

/** Structure definitions as used in multiplayer. */
export function mpStructureDefs(data) {
  const list = (data.building?.structures ?? []).map((def) => {
    const o = MP_OVERRIDES[def.id] ?? {};
    const { requires, ...rest } = def;
    void requires;
    return { ...rest, ...o };
  });
  // The banner first: it is what you build before anything else.
  list.sort((a, b) => (a.id === 'banner' ? -1 : b.id === 'banner' ? 1 : 0));
  return [...list, ...baseStructDefs(data)];
}

/** Game data with multiplayer structure definitions (client and server share it). */
export function mpGameData(data) {
  return { ...data, building: { ...data.building, structures: mpStructureDefs(data), maxStructures: 400 } };
}

/** Level lock text for a structure, or null. */
export function mpStructureLock(def, level) {
  return def.mpLevel && level < def.mpLevel ? `Kräver nivå ${def.mpLevel}` : null;
}
