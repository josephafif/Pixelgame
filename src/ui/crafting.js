// The Forge (spec §17): Blueprint + Material + Core + Modifier rune +
// Catalyst (+ unlocked Ability) → procedural weapon generator.
//
// Laid out as four short steps (type → material → element → quality) with
// optional extras, and a live preview of the weapon on the anvil.

import { h, pixelCanvas } from './dom.js';
import { icon, costChip } from './icons.js';
import { openModal, replaceModalBody } from './modal.js';
import { craftingOptions, validateCraft, craftCost } from '../weapons/crafting.js';
import { generateVisual } from '../weapons/visuals.js';
import { weaponIcon } from '../render/weapon-sprite.js';
import { createRng, hashString } from '../core/rng.js';
import { buildingLevel } from '../game/base.js';

// Last choice, remembered for the next visit (per session).
let lastChoice = null;

/** A stand-in DNA with just enough to draw the weapon's look. */
function previewDna(data, archetypeId, materialId, elementId, rarityId) {
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

function previewIcon(data, archetypeId, materialId, elementId, rarityId, size) {
  const dna = previewDna(data, archetypeId, materialId, elementId, rarityId);
  if (!dna) return h('span');
  const el = pixelCanvas(weaponIcon(dna, 32), size);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function swatch(color) {
  return h('span.swatch', { style: { background: color } });
}

export function open(game, app) {
  const { data, save } = game;
  const opts = craftingOptions(data, save);
  const coreElement = (id) => opts.cores.find((c) => c.id === id)?.element ?? 'physical';

  const choice = {
    archetype: opts.blueprints[0]?.id ?? null,
    material: null,
    core: null,
    rune: null,
    catalyst: 'none',
    ability: null,
  };
  if (lastChoice) {
    const ok = (list, id) => id === null || list.some((x) => x.id === id);
    if (ok(opts.blueprints, lastChoice.archetype)) choice.archetype = lastChoice.archetype;
    if (ok(opts.cores, lastChoice.core)) choice.core = lastChoice.core;
    if (ok(opts.runes, lastChoice.rune)) choice.rune = lastChoice.rune;
    if (ok(opts.abilities, lastChoice.ability)) choice.ability = lastChoice.ability;
    const cat = opts.catalysts.find((c) => c.id === lastChoice.catalyst);
    if (cat && !cat.locked) choice.catalyst = cat.id;
    choice.material = lastChoice.material;
  }
  const fixMaterial = () => {
    const mats = opts.materialsFor(choice.archetype);
    if (!mats.some((m) => m.id === choice.material)) choice.material = mats[0]?.id ?? null;
  };
  fixMaterial();
  let busy = false;

  const rerender = () => {
    const body = document.querySelector('.forge-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };
  const pick = (key, value) => () => {
    choice[key] = value;
    if (key === 'archetype') fixMaterial();
    lastChoice = { ...choice };
    rerender();
  };

  const step = (num, title, picked, content) => h('section.step',
    h('h3.step-title', h('span.num', String(num)), title, picked ? h('span.pick', picked) : null),
    content);

  const chip = (on, onclick, ...children) => h('button.chip', { class: on ? 'on' : null, 'aria-pressed': String(on), onclick }, ...children);

  function typeStep() {
    const a = data.byId.archetypes.get(choice.archetype);
    return step(1, 'Weapon type', a?.name,
      h('div.tiles', opts.blueprints.map((bp) => h('button.tile', {
        class: bp.id === choice.archetype ? 'on' : null,
        'aria-pressed': String(bp.id === choice.archetype),
        onclick: pick('archetype', bp.id),
      }, previewIcon(data, bp.id, opts.materialsFor(bp.id)[0]?.id, 'physical', 'common', 48), bp.name))));
  }

  function materialStep() {
    const mats = opts.materialsFor(choice.archetype);
    const m = data.byId.materials.get(choice.material);
    return step(2, 'Material', m?.name,
      h('div.chips', mats.map((mat) => chip(mat.id === choice.material, pick('material', mat.id),
        swatch(mat.palette[1]), mat.name))));
  }

  function elementStep() {
    const core = opts.cores.find((c) => c.id === choice.core);
    const elName = (id) => data.byId.elements.get(id)?.name ?? id;
    const elColor = (id) => data.byId.elements.get(id)?.palette?.[1] ?? '#a4abb6';
    return step(3, 'Element core', core ? elName(core.element) : 'Physical',
      h('div',
        h('div.chips',
          chip(!choice.core, pick('core', null), swatch('#a4abb6'), 'Physical'),
          opts.cores.map((c) => chip(c.id === choice.core, pick('core', c.id), swatch(elColor(c.element)), c.name))),
        core ? h('p.small.muted', core.desc)
          : !opts.cores.length ? h('p.small.muted', 'Research element cores to forge elemental weapons.') : null));
  }

  function qualityStep() {
    const cat = opts.catalysts.find((c) => c.id === choice.catalyst);
    const r = (id) => data.byId.rarities.get(id);
    return step(4, 'Quality', cat?.name,
      h('div.tiers', opts.catalysts.map((c) => {
        const lo = r(c.minRarity);
        const hi = r(c.maxRarity);
        return h('button.tier', {
          class: c.id === choice.catalyst ? 'on' : null,
          'aria-pressed': String(c.id === choice.catalyst),
          disabled: Boolean(c.locked),
          onclick: pick('catalyst', c.id),
        },
        h('span.name', c.name),
        h('span.range', h('span', { style: { color: lo.color } }, lo.name),
          lo.id === hi.id ? null : [' – ', h('span', { style: { color: hi.color } }, hi.name)]),
        c.locked ? h('span.lock', icon('lock', 12), ' ', c.locked)
          : c.essence ? h('span.small.muted', `+${c.essence} essence`) : h('span.small.muted', 'Free'));
      })));
  }

  function extras() {
    const count = Number(Boolean(choice.rune)) + Number(Boolean(choice.ability));
    return h('details', { open: count > 0 ? true : null },
      h('summary', `Extras — modifier rune & ability${count ? ` (${count})` : ''}`),
      h('h4.step-title', 'Modifier rune'),
      opts.runes.length
        ? h('div.chips',
          chip(!choice.rune, pick('rune', null), 'None'),
          opts.runes.map((m) => chip(m.id === choice.rune, pick('rune', m.id), m.name)))
        : h('p.small.muted', 'Discover weapons to learn their modifiers as runes.'),
      h('h4.step-title', 'Ability'),
      opts.abilities.length
        ? h('div.chips',
          chip(!choice.ability, pick('ability', null), 'None'),
          opts.abilities.map((a) => chip(a.id === choice.ability, pick('ability', a.id), a.name)))
        : h('p.small.muted', 'Find weapons with abilities to unlock them here. Needs a Violet or Golden catalyst.'));
  }

  function preview(errors, cost) {
    const cat = opts.catalysts.find((c) => c.id === choice.catalyst);
    const a = data.byId.archetypes.get(choice.archetype);
    const m = data.byId.materials.get(choice.material);
    const el = coreElement(choice.core);
    const lo = data.byId.rarities.get(cat?.minRarity ?? 'common');
    const hi = data.byId.rarities.get(cat?.maxRarity ?? 'rare');
    const elName = el === 'physical' ? '' : `${data.byId.elements.get(el)?.name} `;
    const rune = opts.runes.find((x) => x.id === choice.rune);
    const ability = opts.abilities.find((x) => x.id === choice.ability);
    const res = save.resources;
    const forgeLevel = buildingLevel(data, save, 'forge');
    const forgeBtn = () => h('button.btn-primary.big', {
      disabled: Boolean(errors.length) || busy,
      onclick: forge,
    }, icon('anvil', 28), busy ? 'Forging…' : 'Forge!');
    return h('aside.forge-preview',
      h('div.anvil-stage', { class: busy ? 'forging' : null },
        a ? previewIcon(data, a.id, m?.id, el, lo.id, 96) : null),
      h('div.result',
        h('span', { style: { color: lo.color } }, lo.name),
        lo.id === hi.id ? null : [' – ', h('span', { style: { color: hi.color } }, hi.name)],
        ` ${elName}${a?.name ?? ''}`),
      h('ul.guarantees',
        h('li', `${m?.name ?? '?'} ${a?.name ?? ''}${elName ? ` with a ${elName.trim()} core` : ''}`),
        rune ? h('li', `+ ${rune.name}`) : null,
        ability ? h('li', `+ ${ability.name}`) : null,
        h('li', 'Stats, bonus modifiers, effects and name are rolled'),
        forgeLevel >= 2 ? h('li.good', `Forge Lv ${forgeLevel}: stronger & cheaper crafts`) : null),
      h('div.cost-row', costChip('scrap', cost.scrap, res.scrap), costChip('essence', cost.essence, res.essence)),
      errors.length ? h('ul.errors', errors.map((e) => h('li', e))) : null,
      forgeBtn());
  }

  /** Phones: cost + Forge button pinned to the bottom while picking. */
  function forgeBar(errors, cost) {
    const res = save.resources;
    return h('div.forge-bar',
      h('div.cost-row', costChip('scrap', cost.scrap, res.scrap), costChip('essence', cost.essence, res.essence)),
      h('button.btn-primary', { disabled: Boolean(errors.length) || busy, onclick: forge },
        icon('anvil', 24), busy ? 'Forging…' : 'Forge!'));
  }

  async function forge() {
    if (busy) return;
    busy = true;
    lastChoice = { ...choice };
    rerender();
    game.audio.play('hit');
    // A short beat of hammering before the reveal.
    await new Promise((r) => setTimeout(r, 450));
    try {
      await game.craft({ ...choice });
    } catch (err) {
      game.toast(err.message, 'warn');
      busy = false;
      rerender();
    }
  }

  function build() {
    if (!opts.blueprints.length) {
      return h('div.empty-state', icon('anvil', 48), h('p', 'Research a weapon blueprint to start forging.'));
    }
    const errors = validateCraft(data, save, choice);
    const cost = craftCost(data, choice, save);
    return h('div.forge',
      h('div.forge-steps',
        typeStep(),
        materialStep(),
        elementStep(),
        qualityStep(),
        extras()),
      preview(errors, cost),
      forgeBar(errors, cost));
  }

  openModal({ title: 'Forge', icon: 'anvil', body: build(), className: 'wide forge-panel' });
}
