// The Forge (spec §17): Blueprint + Material + Core + Modifier rune +
// Catalyst (+ unlocked Ability) → procedural weapon generator.
//
// Laid out as four short steps (type → material → element → quality) with
// optional extras, and a live preview of the weapon on the anvil.

import { h, pixelCanvas } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal, replaceModalBody } from './modal.js';
import {
  craftingOptions, validateCraft, craftCost, optionCost, optionTier, byTier, materialEffects, archetypeSummary,
  runeProblem,
} from '../weapons/crafting.js';
import { unlockSourceFor } from '../weapons/pool.js';
import { buildingLevel } from '../game/base.js';
import { pickaxeDefs, pickaxeBlockers } from '../game/gathering.js';
import { pickaxeSprite } from '../render/structures.js';
import { boatDefs, boatBlockers } from '../game/sailing.js';
import { boatIcon } from '../render/boats.js';
import { previewIcon } from './preview.js';

// Last choice and tab, remembered for the next visit (per session).
let lastChoice = null;
let lastTab = 'weapons';

function swatch(color) {
  return h('span.swatch', { style: { background: color } });
}

/** Filled pips showing how good an option is (basic → best). */
function pips(tier, max) {
  return h('span.tierpips', { 'aria-label': `Tier ${tier} of ${max}` },
    Array.from({ length: max }, (_, i) => h('i', { class: i < tier ? 'on' : null })));
}

/** What an option adds to the price, e.g. "+25 essence". */
function priceTag(cost) {
  const parts = [];
  if (cost.essence) parts.push(h('span', icon('essence', 12), `+${cost.essence}`));
  if (cost.scrap) parts.push(h('span', icon('scrap', 12), `+${cost.scrap}`));
  return h('span.opt-cost', parts.length ? parts : 'Free');
}

const CATALYST_HELP = {
  none: 'Common to rare. The cheapest way to forge.',
  rare: 'Rare or epic: higher stats, more modifiers and a special effect.',
  epic: 'Always epic: lots of modifiers and effects, and room for an ability.',
  legendary: 'Always legendary: the best stats and a signature legendary power. Needs Star Shards from bosses.',
};

export function open(game, app, arg = {}) {
  const { data, save } = game;
  let tab = arg.tab ?? (save.tools?.pickaxe ? lastTab : 'tools');
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
      h('div',
        h('div.tiles', opts.blueprints.map((bp) => h('button.tile', {
          class: bp.id === choice.archetype ? 'on' : null,
          'aria-pressed': String(bp.id === choice.archetype),
          onclick: pick('archetype', bp.id),
        }, previewIcon(data, bp.id, opts.materialsFor(bp.id)[0]?.id, 'physical', 'common', 48), bp.name))),
        a ? explain(h('b', `${a.name}: `), archetypeSummary(a)) : null));
  }

  const explain = (...children) => h('div.explain', ...children);

  function materialStep() {
    const a = data.byId.archetypes.get(choice.archetype);
    const mats = byTier('material', opts.materialsFor(choice.archetype));
    // Materials that would fit but aren't researched yet, so you know they exist.
    const locked = a ? byTier('material', data.materials.filter((mat) => !mats.includes(mat)
      && mat.kinds.some((k) => a.kinds.includes(k)))) : [];
    const m = data.byId.materials.get(choice.material);
    return step(2, 'Material', m?.name,
      h('div',
        h('div.chips.ranked', mats.map((mat) => chip(mat.id === choice.material, pick('material', mat.id),
          swatch(mat.palette[1]), h('span.opt-name', mat.name), pips(mat.tier ?? 1, 5),
          priceTag(optionCost(data, 'material', mat)))),
        locked.map((mat) => h('button.chip.locked', {
          disabled: true,
          title: `Research ${unlockSourceFor(data, 'materials', mat.id)?.name ?? 'its component'} to unlock`,
        }, icon('lock', 12), h('span.opt-name', mat.name), pips(mat.tier ?? 1, 5)))),
        m ? explain(h('b', `${m.name}: `), m.desc ? `${m.desc} ` : '', h('span.fx', materialEffects(m)),
          m.tags?.length ? h('span.muted', ` · more likely to roll ${m.tags.join(', ')} bonuses`) : null)
          : null,
        locked.length ? h('p.small.muted', 'Locked materials are unlocked by researching their component in the Library.') : null));
  }

  function elementStep() {
    const core = opts.cores.find((c) => c.id === choice.core);
    const el = (id) => data.byId.elements.get(id);
    const elColor = (id) => el(id)?.palette?.[1] ?? '#a4abb6';
    const cores = byTier('core', opts.cores);
    const element = el(core?.element ?? 'physical');
    return step(3, 'Element core', core ? element?.name : 'Physical',
      h('div',
        h('div.chips.ranked',
          chip(!choice.core, pick('core', null), swatch('#a4abb6'), h('span.opt-name', 'Physical'), pips(0, 4), priceTag({})),
          cores.map((c) => chip(c.id === choice.core, pick('core', c.id), swatch(elColor(c.element)),
            h('span.opt-name', c.name), pips(optionTier('core', c), 4), priceTag(optionCost(data, 'core', c))))),
        explain(h('b', `${core ? core.name : 'Physical'}: `), element?.desc ?? '',
          core && core.desc && !/^Lets the forge/.test(core.desc) ? h('span.muted', ` ${core.desc}`) : null,
          core?.rarityBonus ? h('span.fx', ' Boss core: one rarity step better.') : null),
        !opts.cores.length ? h('p.small.muted', 'Research element cores in the Library to forge elemental weapons.') : null,
        h('p.small.muted', 'Elemental hits deal 50% more to enemies of the opposite element and 40% less to enemies of the same one.')));
  }

  function qualityStep() {
    const cat = opts.catalysts.find((c) => c.id === choice.catalyst);
    const r = (id) => data.byId.rarities.get(id);
    return step(4, 'Catalyst (rarity)', cat?.name,
      h('div',
        h('div.tiers', opts.catalysts.map((c, i) => {
          const lo = r(c.minRarity);
          const hi = r(c.maxRarity);
          return h('button.tier', {
            class: c.id === choice.catalyst ? 'on' : null,
            'aria-pressed': String(c.id === choice.catalyst),
            disabled: Boolean(c.locked),
            onclick: pick('catalyst', c.id),
          },
          h('span.name', c.name, pips(i + 1, opts.catalysts.length)),
          h('span.range', h('span', { style: { color: lo.color } }, lo.name),
            lo.id === hi.id ? null : [' – ', h('span', { style: { color: hi.color } }, hi.name)]),
          c.locked ? h('span.lock', icon('lock', 12), ' ', c.locked)
            : priceTag({ essence: c.essence, scrap: c.scrap }));
        })),
        cat ? explain(h('b', `${cat.name}: `), CATALYST_HELP[cat.id] ?? '') : null));
  }

  function runeText(m) {
    const [lo, hi] = m.range;
    return m.label.replace('{v}', lo === hi ? String(lo) : `${lo}–${hi}`);
  }

  function extras() {
    const count = Number(Boolean(choice.rune)) + Number(Boolean(choice.ability));
    const rune = opts.runes.find((m) => m.id === choice.rune);
    const ability = opts.abilities.find((a) => a.id === choice.ability);
    const runes = byTier('rune', opts.runes);
    const allRunes = data.modifiers.length;
    return h('details', { open: count > 0 ? true : null },
      h('summary', `Extras — modifier rune & ability${count ? ` (${count})` : ''}`),
      h('h4.step-title', 'Modifier rune'),
      h('p.small.muted', 'A rune puts one bonus of your choice on the weapon for sure. Its size rolls with the rarity.'),
      runes.length
        ? h('div.chips.ranked',
          chip(!choice.rune, pick('rune', null), h('span.opt-name', 'None'), priceTag({})),
          runes.map((m) => {
            const why = m.id === choice.rune ? null : runeProblem(data, choice, m);
            if (why) {
              return h('button.chip.locked', { disabled: true, title: `Not on this weapon (${why})` },
                h('span.opt-name', m.name), pips(optionTier('rune', m), 5));
            }
            return chip(m.id === choice.rune, pick('rune', m.id), h('span.opt-name', m.name),
              pips(optionTier('rune', m), 5), priceTag(optionCost(data, 'rune', m)));
          }))
        : null,
      rune ? explain(h('b', `${rune.name}: `), runeText(rune)) : null,
      h('p.small.muted', runes.length < allRunes
        ? `You know ${runes.length} of ${allRunes} runes. Every modifier on a weapon you find teaches you its rune.`
        : 'You know every rune.'),
      h('h4.step-title', 'Ability'),
      opts.abilities.length
        ? h('div.chips',
          chip(!choice.ability, pick('ability', null), 'None'),
          opts.abilities.map((a) => chip(a.id === choice.ability, pick('ability', a.id), a.name)))
        : h('p.small.muted', 'Find weapons with abilities to unlock them here.'),
      ability ? explain(h('b', `${ability.name}: `), ability.desc, h('span.muted', ` Adds ${data.crafting.abilityCost} essence. Needs a Violet or Golden catalyst.`)) : null);
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
      h('div.cost-row', costChips(cost, res)),
      priceBreakdown(),
      errors.length ? h('ul.errors', errors.map((e) => h('li', e))) : null,
      forgeBtn());
  }

  /** Where the price comes from (before level scaling and Forge discount). */
  function priceBreakdown() {
    const cfg = data.crafting;
    const cat = opts.catalysts.find((c) => c.id === choice.catalyst);
    const m = data.byId.materials.get(choice.material);
    const core = opts.cores.find((c) => c.id === choice.core);
    const rune = opts.runes.find((x) => x.id === choice.rune);
    const fmt = (c) => [c.scrap ? `${c.scrap} scrap` : null, c.essence ? `${c.essence} essence` : null].filter(Boolean).join(' + ');
    const rows = [
      ['Base', { scrap: cfg.scrapCost, essence: cfg.essenceCost }],
      m ? [m.name, optionCost(data, 'material', m)] : null,
      core ? [core.name, optionCost(data, 'core', core)] : null,
      cat ? [cat.name, { scrap: cat.scrap, essence: cat.essence }] : null,
      rune ? [`${rune.name} rune`, optionCost(data, 'rune', rune)] : null,
      choice.ability ? ['Ability', { essence: cfg.abilityCost }] : null,
    ].filter((r) => r && fmt(r[1]));
    return h('details.price-breakdown',
      h('summary', 'Price breakdown'),
      h('ul', rows.map(([label, c]) => h('li', h('span', label), h('span', fmt(c))))),
      h('p.small.muted', 'Prices grow a little with your level; Forge upgrades give a discount.'));
  }

  /** Phones: cost + Forge button pinned to the bottom while picking. */
  function forgeBar(errors, cost) {
    const res = save.resources;
    return h('div.forge-bar',
      h('div.cost-row', costChips(cost, res)),
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

  function boats() {
    const owned = save.tools?.boat ?? 0;
    return [
      h('h3.mh', 'Boats'),
      h('p.small.muted', 'Boats carry you over lakes and the sea to islands. Walk up to the water and press Use to set sail; Use again next to land to go ashore.'),
      h('div.tool-list', boatDefs(data).map((def) => {
        const have = def.tier <= owned;
        const blockers = have ? [] : boatBlockers(data, save, def);
        const hard = blockers.filter((b) => !/^Needs \d+ more /.test(b));
        const art = pixelCanvas(boatIcon(def.id, def.color));
        art.style.height = '56px';
        art.style.width = 'auto';
        const traits = [`Speed ${def.speed}`, def.openSea ? 'Open sea' : 'Coast and lakes only'];
        if (def.armor) traits.push(`Hull takes ${Math.round(def.armor * 100)}% of damage`);
        return h('article.tool-card.framed', { class: have ? 'owned' : null },
          h('div.tool-art.boat-art', art),
          h('div.tool-info',
            h('h3', def.name, have ? h('span.badge', def.tier === owned ? 'Yours' : 'Owned') : null),
            h('p.small', def.desc),
            h('p.small.muted', traits.join(' · ')),
            have ? null : h('div.row',
              costChips(def.cost, save.resources),
              hard.length ? h('span.req', icon('lock', 16), ' ', hard[0]) : null,
              h('button.btn-primary', {
                disabled: blockers.length > 0,
                onclick: () => {
                  if (game.buildBoat(def.tier)) rerender();
                },
              }, icon('hammer', 20), 'Build'))));
      })),
    ];
  }

  /** What a pickaxe tier unlocks, e.g. "obsidian". */
  function minesWith(tier) {
    return Object.values(data.gathering.harvest).filter((hv) => hv.tier === tier && tier > 1)
      .map((hv) => hv.name.toLowerCase()).join(', ');
  }

  function tools() {
    const owned = save.tools?.pickaxe ?? 0;
    return h('div.tools',
      h('p.small.muted', 'Pickaxes chop trees and break rocks for wood and stone, which you need to build walls, turrets and camp upgrades.'),
      h('div.tool-list', pickaxeDefs(data).map((def) => {
        const have = def.tier <= owned;
        const blockers = have ? [] : pickaxeBlockers(data, save, def);
        const hard = blockers.filter((b) => !/^Needs \d+ more /.test(b));
        const art = pixelCanvas(pickaxeSprite(def.color));
        art.style.width = '48px';
        art.style.height = '56px';
        return h('article.tool-card.framed', { class: have ? 'owned' : null },
          h('div.tool-art', art),
          h('div.tool-info',
            h('h3', def.name, have ? h('span.badge', def.tier === owned ? 'Equipped' : 'Owned') : null),
            h('p.small', def.desc),
            h('p.small.muted', [
              `Speed ×${def.power}`,
              def.yield ? `+${Math.round((def.yield - 1) * 100)}% materials` : null,
              minesWith(def.tier) ? `mines ${minesWith(def.tier)}` : null,
            ].filter(Boolean).join(' · ')),
            have ? null : h('div.row',
              costChips(def.cost, save.resources),
              hard.length ? h('span.req', icon('lock', 16), ' ', hard[0]) : null,
              h('button.btn-primary', {
                disabled: blockers.length > 0,
                onclick: () => {
                  if (game.forgePickaxe(def.tier)) rerender();
                },
              }, icon('anvil', 20), 'Forge'))));
      })),
      boats());
  }

  function tabs() {
    const pick = (id) => () => {
      tab = id;
      lastTab = id;
      rerender();
    };
    return h('div.tabs', { role: 'tablist' },
      h('button.tab', { role: 'tab', class: tab === 'weapons' ? 'active' : null, 'aria-selected': String(tab === 'weapons'), onclick: pick('weapons') },
        icon('sword', 20), 'Weapons'),
      h('button.tab', { role: 'tab', class: tab === 'tools' ? 'active' : null, 'aria-selected': String(tab === 'tools'), onclick: pick('tools') },
        icon('pickaxe', 20), 'Tools', save.tools?.pickaxe ? null : h('span.dot')));
  }

  function build() {
    if (tab === 'tools') return h('div', tabs(), tools());
    if (!opts.blueprints.length) {
      return h('div', tabs(), h('div.empty-state', icon('anvil', 48), h('p', 'Research a weapon blueprint to start forging.')));
    }
    const errors = validateCraft(data, save, choice);
    const cost = craftCost(data, choice, save);
    return h('div', tabs(), h('div.forge',
      h('div.forge-steps',
        h('p.forge-guide', 'Pick a weapon type, then a material (its base stats), an element core and a catalyst (how rare it gets). '
          + 'Each row runs from basic on the left to best on the right: the better your pick, the higher the price.'),
        typeStep(),
        materialStep(),
        elementStep(),
        qualityStep(),
        extras()),
      preview(errors, cost),
      forgeBar(errors, cost)));
  }

  // A new pickaxe (or, in multiplayer, the server's answer) refreshes the panel.
  const off = game.on('tools', () => {
    if (!busy) rerender();
  });
  openModal({ title: 'Forge', icon: 'anvil', body: build(), className: 'wide forge-panel', onDispose: off });
}
