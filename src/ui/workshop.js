// The Weapon Workshop (main menu): make any weapon you like. Forge one from
// scratch with any rarity, type, material, element and ability, then change
// everything about it by hand — name, rarity, element, type, every stat,
// modifiers, effects, the ability (or a legendary's power), a drawback, its
// look and its sound — with the weapon card updating as you go. Copy its code
// to share it (the code carries the whole weapon), paste any weapon code to
// open it here, and in single player put it in your bag to use it.

import { h, pixelCanvas } from './dom.js';
import { icon } from './icons.js';
import { openModal, replaceModalBody, askConfirm, showText } from './modal.js';
import { weaponCard } from './weapon-card.js';
import { weaponIcon } from '../render/weapon-sprite.js';
import { salvageValue } from '../game/loot.js';
import { sellPrice } from '../game/economy.js';
import { serializeDna } from '../weapons/dna.js';
import {
  forgeWeapon, makeModifier, makeEffect, makeDrawback, makeAbility, changeArchetype, recomputeStats, derived,
  newLook, newSound, newName, workshopCopy, encodeWeaponCode, decodeWeaponCode, fingerprint, workshopProblems,
} from '../weapons/workshop.js';
import { fillTemplate, resolveHooks } from '../weapons/generator.js';

const STAT_FIELDS = [
  ['damage', 'Damage', 1, 1, 99999], ['attackSpeed', 'Attack speed', 0.01, 0.05, 20], ['range', 'Range', 0.1, 0.5, 30],
  ['critChance', 'Crit chance %', 1, 0, 100], ['critDamage', 'Crit damage %', 1, 100, 2000], ['projectileSpeed', 'Projectile speed', 0.1, 0, 60],
  ['projectiles', 'Projectiles', 1, 0, 20], ['pierce', 'Pierce', 1, 0, 99], ['homing', 'Homing (0/1)', 1, 0, 1],
  ['knockback', 'Knockback', 1, 0, 20], ['split', 'Split', 1, 0, 10],
];
const BASE_FIELDS = [['damage', 'Damage', 1], ['attackSpeed', 'Attack speed', 0.01], ['range', 'Range', 0.1], ['critChance', 'Crit chance %', 1], ['critDamage', 'Crit damage %', 1]];
const ATTACK_FIELDS = [['arc', 'Swing arc°', 1], ['width', 'Width', 0.05], ['radius', 'Radius', 0.1], ['blast', 'Blast', 0.1], ['spread', 'Spread°', 1], ['size', 'Shot size', 1]];
const ABILITY_FIELDS = [['damage', 'Damage', 1], ['radius', 'Radius', 0.1], ['duration', 'Duration s', 0.1], ['cooldown', 'Cooldown s', 0.1], ['count', 'Count', 1], ['range', 'Range', 0.1], ['slow', 'Slow %', 1]];
const PALETTE = [['blade', 0, 'Blade light'], ['blade', 1, 'Blade'], ['blade', 2, 'Blade dark'], ['handle', 0, 'Handle'], ['handle', 1, 'Handle dark'], ['accent', null, 'Accent'], ['gem', null, 'Gem'], ['glow', null, 'Glow'], ['outline', null, 'Outline']];
const EDGES = ['smooth', 'serrated', 'crystal', 'jagged'];
const PARTICLES = ['', 'ember', 'frost', 'spark', 'toxic', 'void', 'holy', 'blood', 'dust', 'arcane', 'leaf', 'sparkle', 'smoke', 'glint'];
const WAVES = ['square', 'sawtooth', 'triangle', 'sine'];

const num = (v, step) => (step >= 1 ? Math.round(v) : Math.round(v / step) * step);

export function open(game, app, { dna: start = null } = {}) {
  const { data } = game;
  const inMp = Boolean(app?.mpMode || game.mp);
  const openSections = new Set(['forge', 'identity']);
  const history = [];
  let dna = start ? serializeDna(start) : forgeWeapon(data, { rarity: 'epic', level: Math.max(20, game.save?.player?.level ?? 1) });
  let auto = true; // stats follow base stats and modifiers
  let code = '';
  let codeFor = '';
  const forge = { rarity: dna.rarity, archetype: dna.archetype, material: dna.material, element: dna.element, ability: '', rune: '', level: dna.ctx?.lvl ?? 20, seed: dna.seed };

  function set(next, { keepAuto = false } = {}) {
    history.push(dna);
    if (history.length > 40) history.shift();
    dna = keepAuto || !auto ? { ...next, ...derived(data, next) } : recomputeStats(data, next);
    rerender();
  }

  function rerender() {
    const body = document.querySelector('.workshop-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    const editor = document.querySelector('.ws-edit');
    const editScroll = editor?.scrollTop ?? 0;
    replaceModalBody(build());
    const b2 = document.querySelector('.workshop-panel .panel-body');
    if (b2) b2.scrollTop = scroll;
    const e2 = document.querySelector('.ws-edit');
    if (e2) e2.scrollTop = editScroll;
    refreshCode();
  }

  async function refreshCode() {
    const fp = fingerprint(dna);
    if (fp === codeFor) return;
    codeFor = fp;
    try {
      code = await encodeWeaponCode(dna);
    } catch {
      code = '';
    }
    const field = document.querySelector('.ws-code-field');
    if (field && codeFor === fp) field.value = code;
  }

  // --- Small form helpers --------------------------------------------------------------

  const field = (label, control) => h('label.ws-field', h('span', label), control);
  const numberInput = (value, step, onChange, { min = null, max = null } = {}) => {
    const el = h('input', { type: 'number', step: String(step), value: String(value ?? 0), min: min ?? null, max: max ?? null });
    el.addEventListener('change', () => {
      let v = Number(el.value);
      if (!Number.isFinite(v)) return;
      if (min !== null) v = Math.max(min, v);
      if (max !== null) v = Math.min(max, v);
      onChange(num(v, step));
    });
    return el;
  };
  const select = (value, options, onChange) => {
    const el = h('select', options.map(([v, label]) => h('option', { value: v, selected: v === value ? true : null }, label)));
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const textInput = (value, onChange, { maxlength = 60 } = {}) => {
    const el = h('input', { type: 'text', value, maxlength });
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const color = (value, onChange) => {
    const el = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#ffffff' });
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const check = (value, onChange, label) => {
    const el = h('input', { type: 'checkbox', checked: value ? true : null });
    el.addEventListener('change', () => onChange(el.checked));
    return h('label.ws-check', el, label);
  };
  const section = (id, title, ...content) => {
    const d = h('details.ws-section', { open: openSections.has(id) ? true : null, 'data-section': id }, h('summary', title), h('div.ws-section-body', ...content));
    d.addEventListener('toggle', () => (d.open ? openSections.add(id) : openSections.delete(id)));
    return d;
  };
  const names = (list) => list.map((x) => [x.id, x.name ?? x.id]);
  const rarityOptions = data.rarities.map((r) => [r.id, r.name]);
  const elementOptions = data.elements.map((e) => [e.id, e.name]);
  const fitsOf = (archetypeId) => {
    const a = data.byId.archetypes.get(archetypeId);
    return data.materials.filter((m) => m.kinds.some((k) => a?.kinds.includes(k)));
  };

  // --- Sections ---------------------------------------------------------------------------

  function forgeSection() {
    const fits = fitsOf(forge.archetype);
    if (!fits.some((m) => m.id === forge.material)) forge.material = fits[0]?.id;
    return section('forge', 'Forge a new weapon',
      h('p.small.muted', 'Free and without limits: pick anything, then press Forge. Everything can be changed by hand afterwards.'),
      h('div.ws-grid',
        field('Rarity', select(forge.rarity, rarityOptions, (v) => { forge.rarity = v; rerender(); })),
        field('Type', select(forge.archetype, names(data.archetypes), (v) => { forge.archetype = v; rerender(); })),
        field('Material', select(forge.material, names(fits), (v) => { forge.material = v; })),
        field('Element', select(forge.element, elementOptions, (v) => { forge.element = v; })),
        field('Ability', select(forge.ability, [['', 'Any / none'], ...names(data.abilities)], (v) => { forge.ability = v; })),
        field('Rune (modifier)', select(forge.rune, [['', 'None'], ...names(data.modifiers)], (v) => { forge.rune = v; })),
        field('Level', numberInput(forge.level, 1, (v) => { forge.level = v; }, { min: 1, max: 99 })),
        field('Seed', numberInput(forge.seed, 1, (v) => { forge.seed = v >>> 0; }, { min: 0, max: 4294967295 }))),
      h('div.row',
        h('button.btn-primary', {
          onclick: () => {
            auto = true;
            set(forgeWeapon(data, {
              seed: forge.seed, level: forge.level, rarity: forge.rarity, archetype: forge.archetype, material: forge.material,
              element: forge.element, ability: forge.ability || null, rune: forge.rune || null,
            }));
          },
        }, icon('anvil', 20), 'Forge'),
        h('button', {
          onclick: () => {
            forge.seed = Math.floor(Math.random() * 0xffffffff);
            auto = true;
            set(forgeWeapon(data, { seed: forge.seed, level: forge.level, rarity: forge.rarity, archetype: forge.archetype, material: forge.material, element: forge.element, ability: forge.ability || null, rune: forge.rune || null }));
          },
        }, icon('star', 20), 'Re-roll'),
        h('button', {
          onclick: () => {
            forge.seed = Math.floor(Math.random() * 0xffffffff);
            auto = true;
            const w = forgeWeapon(data, { seed: forge.seed, level: forge.level, rarity: forge.rarity });
            Object.assign(forge, { archetype: w.archetype, material: w.material, element: w.element });
            set(w);
          },
        }, 'Surprise me')));
  }

  function identitySection() {
    const legendary = dna.rarity === 'legendary' && dna.ability;
    return section('identity', 'Name, rarity, type and element',
      h('div.ws-grid',
        field('Name', textInput(dna.name.text, (v) => set({ ...dna, name: { ...dna.name, text: v.trim() || dna.name.text } }, { keepAuto: true }))),
        h('button.small', { onclick: () => set({ ...dna, name: newName(data, dna) }, { keepAuto: true }) }, 'New name'),
        field('Rarity', select(dna.rarity, rarityOptions, (v) => set({ ...dna, rarity: v }))),
        field('Type', select(dna.archetype, names(data.archetypes), (v) => set(changeArchetype(data, dna, v)))),
        field('Material', select(dna.material, names(fitsOf(dna.archetype)), (v) => set(changeArchetype(data, dna, dna.archetype, v)))),
        field('Element', select(dna.element, elementOptions, (v) => set({ ...dna, element: v, ability: dna.ability ? { ...dna.ability, infuse: v === 'physical' ? null : v } : null }))),
        field('Playstyle', select(dna.theme, data.themes.map((t) => [t.id, t.label]), (v) => {
          const t = data.themes.find((x) => x.id === v);
          set({ ...dna, theme: v, identity: t?.label ?? dna.identity }, { keepAuto: true });
        })),
        field('Level', numberInput(dna.ctx?.lvl ?? 1, 1, (v) => set({ ...dna, ctx: { ...dna.ctx, lvl: v } }), { min: 1, max: 99 })),
        legendary ? field('Legendary power', select(dna.signature ?? '', [['', 'From the seed'], ...names(data.legendaryAbilities ?? [])], (v) => {
          const next = { ...dna };
          if (v) next.signature = v;
          else delete next.signature;
          set(next, { keepAuto: true });
        })) : null),
      dna.rarity === 'legendary' && !dna.ability ? h('p.small.muted', 'Give it an ability (below) and a legendary weapon turns it into a Legendary Power.') : null);
  }

  function statsSection() {
    const stat = (key, label, step, min, max) => field(label, numberInput(dna.stats[key], step, (v) => {
      auto = false;
      set({ ...dna, stats: { ...dna.stats, [key]: v } }, { keepAuto: true });
    }, { min, max }));
    const baseStat = (key, label, step) => field(label, numberInput(dna.base?.[key] ?? 0, step, (v) => set({ ...dna, base: { ...dna.base, [key]: v } }), { min: 0 }));
    const attackKeys = ATTACK_FIELDS.filter(([k]) => dna.attack[k] !== undefined);
    return section('stats', 'Stats',
      check(auto, (v) => {
        auto = v;
        if (v) set(dna);
        else rerender();
      }, 'Work the final stats out from the base stats and modifiers (the game’s caps apply)'),
      auto
        ? h('div.ws-grid', BASE_FIELDS.map(([k, label, step]) => baseStat(k, `Base ${label.toLowerCase()}`, step)))
        : h('p.small.muted', 'Free mode: the numbers below are the weapon’s final stats, exactly as you set them.'),
      h('div.ws-grid', STAT_FIELDS.map(([k, label, step, min, max]) => stat(k, label, step, min, max))),
      attackKeys.length ? h('h4', `Attack: ${dna.attack.pattern}`) : null,
      attackKeys.length ? h('div.ws-grid', attackKeys.map(([k, label, step]) => field(label, numberInput(dna.attack[k], step, (v) => set({ ...dna, attack: { ...dna.attack, [k]: v } }, { keepAuto: true }), { min: 0 })))) : null);
  }

  function modifiersSection() {
    let pick = data.modifiers[0]?.id;
    const rows = dna.modifiers.map((m, i) => {
      const def = data.byId.modifiers.get(m.id);
      return h('div.ws-row',
        h('span.ws-row-name', { class: `mod-${m.category}` }, m.label),
        numberInput(m.v, def?.step ?? 1, (v) => {
          const mods = dna.modifiers.slice();
          mods[i] = def ? makeModifier(data, m.id, v) : { ...m, v, label: m.label };
          set({ ...dna, modifiers: mods });
        }),
        h('button.small.btn-danger', { 'aria-label': `Remove ${m.name}`, onclick: () => set({ ...dna, modifiers: dna.modifiers.filter((_, k) => k !== i) }) }, '✕'));
    });
    const groups = {};
    for (const m of data.modifiers) (groups[m.category] ??= []).push(m);
    const picker = h('select', Object.entries(groups).map(([cat, list]) => h('optgroup', { label: cat }, list.map((m) => h('option', { value: m.id }, `${m.name} (${m.range.join('–')})`)))));
    picker.addEventListener('change', () => { pick = picker.value; });
    return section('mods', `Modifiers (${dna.modifiers.length})`,
      rows.length ? h('div.ws-rows', rows) : h('p.small.muted', 'No modifiers.'),
      h('div.row', picker, h('button', { onclick: () => set({ ...dna, modifiers: [...dna.modifiers, makeModifier(data, pick)] }) }, '+ Add')),
      h('p.small.muted', 'Any value works, also beyond the usual range (the number is what the modifier does).'));
  }

  function effectsSection() {
    let pick = data.effects[0]?.id;
    const picker = select(pick, data.effects.map((e) => [e.id, `${e.name}: ${e.desc}`]), (v) => { pick = v; });
    return section('effects', `Special effects (${dna.effects.length})`,
      dna.effects.length ? h('div.ws-rows', dna.effects.map((e, i) => h('div.ws-row',
        h('span.ws-row-name', h('b', e.name), ' — ', e.desc),
        h('button.small.btn-danger', { 'aria-label': `Remove ${e.name}`, onclick: () => set({ ...dna, effects: dna.effects.filter((_, k) => k !== i) }) }, '✕')))) : h('p.small.muted', 'No special effects.'),
      h('div.row', picker, h('button', { onclick: () => set({ ...dna, effects: [...dna.effects, makeEffect(data, pick)] }) }, '+ Add')));
  }

  function abilitySection() {
    const ab = dna.ability;
    const twists = [['', 'No twist'], ...data.abilityTwists.map((t) => [t.id, `${t.name}: ${t.desc}`])];
    const rebuild = (id, twist = ab?.twist ?? null, power = 0.75) => set({ ...dna, ability: id ? makeAbility(data, id, { element: dna.element, twist, power }) : null });
    return section('ability', 'Ability',
      h('div.ws-grid',
        field('Ability', select(ab?.id ?? '', [['', 'None'], ...data.abilities.map((a) => [a.id, `${a.name}: ${a.desc}`])], (v) => rebuild(v || null))),
        ab ? field('Twist', select(ab.twist ?? '', twists, (v) => rebuild(ab.id, v || null))) : null,
        ab ? field('Strength', select('', [['', 'Pick to reset…'], ['0', 'Weakest'], ['0.5', 'Middle'], ['1', 'Strongest']], (v) => v !== '' && rebuild(ab.id, ab.twist, Number(v)))) : null,
        ab ? field('Name', textInput(ab.name, (v) => set({ ...dna, ability: { ...ab, name: v || ab.name } }, { keepAuto: true }))) : null),
      ab ? h('div.ws-grid', ABILITY_FIELDS.map(([k, label, step]) => field(label, numberInput(ab[k] ?? 0, step, (v) => set({ ...dna, ability: { ...ab, [k]: v } }, { keepAuto: true }), { min: 0 })))) : null);
  }

  function drawbackSection() {
    const db = dna.drawback;
    const def = db ? data.byId.drawbacks.get(db.id) : null;
    return section('drawback', 'Drawback',
      h('div.ws-grid',
        field('Drawback', select(db?.id ?? '', [['', 'None'], ...data.drawbacks.map((d) => [d.id, `${d.name}: ${fillTemplate(d.label, d.range[0])}`])], (v) => set({ ...dna, drawback: v ? makeDrawback(data, v) : null }))),
        db ? field('Value', numberInput(db.v, def?.step ?? 1, (v) => set({
          ...dna,
          drawback: { ...db, v, label: fillTemplate(def?.label ?? '{v}', v), ...(def?.hooks ? { hooks: resolveHooks(def.hooks, v) } : {}) },
        }))) : null));
  }

  function lookSection() {
    const v = dna.visual;
    const look = (patch) => set({ ...dna, visual: { ...v, ...patch } }, { keepAuto: true });
    const pal = (key, idx, value) => {
      const palette = { ...v.palette };
      if (idx === null) palette[key] = value;
      else {
        palette[key] = palette[key].slice();
        palette[key][idx] = value;
      }
      look({ palette });
    };
    const templates = [...new Set(data.archetypes.map((a) => a.sprite.template))];
    return section('look', 'Look',
      h('div.row',
        h('button', { onclick: () => set({ ...dna, visual: newLook(data, dna) }, { keepAuto: true }) }, icon('star', 18), 'New look'),
        h('button', { onclick: () => set({ ...dna, visual: newLook(data, dna, dna.seed) }, { keepAuto: true }) }, 'Its own look')),
      h('div.ws-grid',
        field('Shape', select(v.template, templates.map((t) => [t, t]), (t) => {
          // Another shape takes the sizes and choices that shape is drawn with.
          const a = data.archetypes.find((x) => x.sprite.template === t);
          const dims = {};
          for (const [k, [lo, hi]] of Object.entries(a.sprite.dims ?? {})) dims[k] = Math.round((lo + hi) / 2);
          const choices = {};
          for (const [k, list] of Object.entries(a.sprite.choices ?? {})) choices[k] = list[0];
          look({ template: t, dims, choices });
        })),
        ...Object.entries(v.dims ?? {}).map(([k, val]) => field(`Size: ${k}`, numberInput(val, 1, (n) => look({ dims: { ...v.dims, [k]: n } }), { min: 1, max: 24 }))),
        ...Object.entries(v.choices ?? {}).map(([k, val]) => {
          const a = data.archetypes.find((x) => x.sprite.template === v.template);
          const list = a?.sprite.choices?.[k] ?? [val];
          return field(k, select(String(val), list.map((o) => [String(o), String(o)]), (o) => look({ choices: { ...v.choices, [k]: o === 'true' ? true : o === 'false' ? false : o } })));
        }),
        field('Edge', select(v.edge, EDGES.map((e) => [e, e]), (e) => look({ edge: e }))),
        field('Particles', select(v.particles?.kind ?? '', PARTICLES.map((p) => [p, p || 'none']), (p) => look({ particles: p ? { kind: p, rate: v.particles?.rate ?? 0.6 } : null }))),
        v.particles ? field('Particle rate', numberInput(v.particles.rate, 0.05, (r) => look({ particles: { ...v.particles, rate: r } }), { min: 0, max: 3 })) : null,
        field('Variant', numberInput(v.variant ?? 0, 1, (n) => look({ variant: n }), { min: 0, max: 255 }))),
      h('div.ws-colors', PALETTE.filter(([k]) => k in v.palette).map(([k, idx, label]) => field(label, color(idx === null ? v.palette[k] : v.palette[k]?.[idx], (c) => pal(k, idx, c))))),
      h('div.ws-grid',
        field('Trail', color(v.trail, (c) => look({ trail: c }))),
        check(v.glow, (g) => look({ glow: g }), 'Glow'),
        check(v.runes, (r) => look({ runes: r }), 'Runes'),
        check(v.distortion, (d) => look({ distortion: d }), 'Distortion')));
  }

  function soundSection() {
    const s = dna.sound;
    const sound = (patch) => set({ ...dna, sound: { ...s, ...patch } }, { keepAuto: true });
    const types = [...new Set(data.archetypes.map((a) => a.sound.type))];
    return section('sound', 'Sound',
      h('div.row',
        h('button', { onclick: () => { game.audio.unlock?.(); game.audio.weapon(s); } }, '▶ Play'),
        h('button', { onclick: () => set({ ...dna, sound: newSound(data, dna) }, { keepAuto: true }) }, 'New sound')),
      h('div.ws-grid',
        field('Kind', select(s.type, types.map((t) => [t, t]), (t) => sound({ type: t }))),
        field('Wave', select(s.wave, WAVES.map((w) => [w, w]), (w) => sound({ wave: w }))),
        field('Pitch Hz', numberInput(s.pitch, 1, (p) => sound({ pitch: p }), { min: 40, max: 4000 })),
        field('Decay s', numberInput(s.decay, 0.01, (d) => sound({ decay: d }), { min: 0.01, max: 2 })),
        field('Sweep', numberInput(s.sweep, 0.01, (w) => sound({ sweep: w }), { min: -2, max: 2 })),
        check(s.shimmer, (on) => sound({ shimmer: on }), 'Shimmer')));
  }

  // --- The whole page -------------------------------------------------------------------------

  function preview() {
    // Sprites are cached by id: draw this version under an id of its own.
    const look = { ...dna, id: `ws:${fingerprint(dna)}` };
    const big = pixelCanvas(weaponIcon(look, 32), 160);
    big.classList.add('ws-big');
    const equipped = !inMp && game.save?.inventory?.equipped ? game.findWeapon?.(game.save.inventory.equipped) : null;
    const salvage = salvageValue(dna);
    const problems = workshopProblems(data, dna);
    return h('div.ws-preview',
      h('div.ws-stage', { class: `r-${dna.rarity}` }, big),
      problems.length ? h('p.warn.small', icon('skull', 16), ` ${problems[0]}`) : null,
      weaponCard(data, look, { compareTo: equipped }),
      h('p.small.muted', `Sells for ${sellPrice(dna).toLocaleString()} gold · salvages to ${salvage.scrap} scrap and ${salvage.essence} essence`));
  }

  function codeBox() {
    const out = h('input.ws-code-field', { type: 'text', readonly: true, value: code, 'aria-label': 'Weapon code' });
    out.addEventListener('focus', () => out.select());
    const paste = h('input', { type: 'text', placeholder: 'Paste a weapon code (PGX1… or PGW1…)', 'aria-label': 'Paste a weapon code' });
    const load = async () => {
      try {
        const w = await decodeWeaponCode(data, paste.value);
        auto = false;
        set(w, { keepAuto: true });
        game.toast?.(`Opened ${w.name.text}`, 'info');
      } catch (err) {
        game.toast?.(err.message, 'warn');
      }
    };
    paste.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') load();
    });
    return h('section.ws-code',
      h('h4', 'Weapon code'),
      h('p.small.muted', 'The code carries the whole weapon, every change included. Anyone can open it here (or in the Codex).'),
      h('div.row.ws-code-row', out, h('button.btn-primary', {
        onclick: async () => {
          await refreshCode();
          try {
            await navigator.clipboard.writeText(code);
            game.toast?.('Weapon code copied', 'info');
          } catch {
            showText({ title: 'Weapon code', text: 'Copy this code:', value: code });
          }
        },
      }, 'Copy code')),
      h('div.row.ws-code-row', paste, h('button', { onclick: load }, 'Open')));
  }

  function actions() {
    const give = async (equip) => {
      const problems = workshopProblems(data, dna);
      if (problems.length) {
        game.toast(`This weapon can't be used yet: ${problems[0]}`, 'warn');
        return;
      }
      const ok = await askConfirm({
        title: 'Into your bag?',
        text: 'A copy of this weapon goes into your single-player bag, marked as made in the Workshop. It works like any other weapon.',
        ok: equip ? 'Add and equip' : 'Add to bag',
      });
      if (!ok) return;
      const copy = workshopCopy(dna);
      game.addWeapon(copy);
      if (equip) game.equip(copy.id, 'main');
      await game.saveNow?.();
      game.toast(`${copy.name.text} is in your bag.`, 'level');
    };
    return h('div.row.ws-actions',
      h('button', { disabled: !history.length, onclick: () => { dna = history.pop(); rerender(); } }, 'Undo'),
      inMp ? h('span.small.muted', 'In multiplayer the server makes every weapon: share the code instead.') : [
        h('button', { onclick: () => give(false) }, icon('bag', 18), 'Add to my bag'),
        h('button.btn-primary', { onclick: () => give(true) }, icon('sword', 18), 'Add and equip'),
      ]);
  }

  function build() {
    return h('div.workshop',
      actions(),
      h('div.ws-main',
        h('div.ws-left', preview(), codeBox()),
        h('div.ws-edit',
          forgeSection(),
          identitySection(),
          statsSection(),
          modifiersSection(),
          effectsSection(),
          abilitySection(),
          drawbackSection(),
          lookSection(),
          soundSection())));
  }

  openModal({ title: 'Weapon Workshop', icon: 'anvil', body: build(), className: 'wide workshop-panel' });
  refreshCode();
}
