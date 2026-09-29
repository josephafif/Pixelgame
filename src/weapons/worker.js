// Web Worker entry: runs weapon generation off the main thread so a burst
// of drops (boss loot, chests) never stalls rendering or input.

import { prepareGameData } from '../data/gamedata.js';
import { generateWeapon, regenerate } from './generator.js';

let data = null;

self.onmessage = (event) => {
  const { id, type, payload } = event.data ?? {};
  try {
    let result;
    if (type === 'init') {
      data = prepareGameData(payload);
      result = { dataVersion: data.dataVersion };
    } else if (!data) {
      throw new Error('Weapon worker used before init');
    } else if (type === 'generate') {
      result = generateWeapon(data, payload);
    } else if (type === 'generateMany') {
      result = payload.map((req) => generateWeapon(data, req));
    } else if (type === 'regenerate') {
      result = regenerate(data, payload);
    } else {
      throw new Error(`Unknown worker message ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};
