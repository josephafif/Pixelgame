// Weapon look-alikes for UI previews (forge anvil, case-opening strip):
// just enough DNA to draw a weapon of a given type, material, element and
// rarity, without running the whole generator.

import { h, pixelCanvas } from './dom.js';
import { generateVisual } from '../weapons/visuals.js';
import { weaponIcon } from '../render/weapon-sprite.js';
import { createRng, hashString } from '../core/rng.js';

/** A stand-in DNA with just enough to draw the weapon's look. */
export function previewDna(data, archetypeId, materialId, elementId, rarityId) {
  const archetype = data.byId.archetypes.get(archetypeId);
  const material = data.byId.materials.get(materialId) ?? data.materials[0];
  const element = data.byId.elements.get(elementId ?? 'physical') ?? data.elements[0];
  const rarity = data.byId.rarities.get(rarityId) ?? data.rarities[0];
  if (!archetype) return null;
  const id = `preview:${archetype.id}:${material.id}:${element.id}:${rarity.id}`;
  const visual = generateVisual(data, {
    archetype, material, element, rarity, rarityIdx: data.rarityIndex.get(rarity.id), stateTags: new Set(),
  }, createRng(hashString(id)));
  return { id, visual };
}

export function previewIcon(data, archetypeId, materialId, elementId, rarityId, size) {
  const dna = previewDna(data, archetypeId, materialId, elementId, rarityId);
  if (!dna) return h('span');
  const el = pixelCanvas(weaponIcon(dna, 32), size);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** A random plausible weapon icon of the given rarity (case-opening filler). */
export function randomPreviewIcon(data, rarityId, size, rand = Math.random) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const archetype = pick(data.archetypes);
  const mats = data.materials.filter((m) => m.kinds.some((k) => archetype.kinds.includes(k)));
  const material = pick(mats.length ? mats : data.materials);
  const element = rand() < 0.5 ? 'physical' : pick(data.elements).id;
  return previewIcon(data, archetype.id, material.id, element, rarityId, size);
}
