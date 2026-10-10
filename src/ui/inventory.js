// Inventory (bag + storage), character sheet and weapon codex.
//
// Navigation: tabs with counts, sort and filter chips, a slot grid with
// badges (1 = main, 2 = secondary, NEW, ★ favorite) and a detail pane that
// compares with the weapon in hand. Keyboard: arrows move, Enter equips as
// main, 2 as secondary, T moves
// between bag and storage, F favorites, X salvages, Q/E switch tabs.

import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal, replaceModalBody, askConfirm, showText, isDialogOpen } from './modal.js';
import { weaponCard, weaponIconEl } from './weapon-card.js';
import { statSheet } from '../game/stats.js';
import { baseBonuses } from '../game/base.js';
import { encodeDnaCode, decodeDnaCode } from '../weapons/dna.js';
import { decodeWeaponCode, encodeWeaponCode } from '../weapons/workshop.js';
import { rarityInfo, summaryLine, dpsEstimate, archetypeName } from '../weapons/describe.js';
import { salvageValue } from '../game/loot.js';

const TABS = [['bag', 'Bag', 'bag'], ['storage', 'Storage', 'chest'], ['character', 'Hero', 'heart'], ['codex', 'Codex', 'book']];
const SORTS = [['new', 'Newest'], ['rarity', 'Rarity'], ['power', 'Power'], ['type', 'Type']];
const FILTERS = [['all', 'All'], ['melee', 'Melee'], ['ranged', 'Ranged'], ['special', 'Special'], ['fav', '★']];

// Remembered between openings (per session).
const view = { sort: 'new', filter: 'all' };

export function open(game, app, arg = {}) {
  const initialTab = typeof arg === 'string' ? arg : arg.tab;
  const { data } = game;
  const inv = () => game.save.inventory;
  let tab = TABS.some(([id]) => id === initialTab) ? initialTab : 'bag';
  let selected = inv().equipped;
  let bulk = false;
  let codexPreview = null;
  let focusGrid = false;

  const rerender = () => {
    const body = document.querySelector('.inventory-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
    if (focusGrid) document.querySelector('.inventory-panel .slot.selected')?.focus({ preventScroll: true });
  };

  // --- Lists ---------------------------------------------------------------------

  function visible(which) {
    const i = inv();
    const list = which === 'bag' ? i.bag : i.storage;
    const cls = (dna) => data.byId.archetypes.get(dna.archetype)?.class;
    let out = list.map((dna, idx) => ({ dna, idx }));
    if (view.filter === 'fav') out = out.filter(({ dna }) => i.favorites.includes(dna.id));
    else if (view.filter !== 'all') out = out.filter(({ dna }) => cls(dna) === view.filter);
    const rarity = (dna) => data.rarityIndex.get(dna.rarity) ?? 0;
    const by = {
      new: (a, b) => b.idx - a.idx,
      rarity: (a, b) => rarity(b.dna) - rarity(a.dna) || dpsEstimate(b.dna) - dpsEstimate(a.dna),
      power: (a, b) => dpsEstimate(b.dna) - dpsEstimate(a.dna),
      type: (a, b) => archetypeName(data, a.dna.archetype).localeCompare(archetypeName(data, b.dna.archetype))
        || rarity(b.dna) - rarity(a.dna),
    }[view.sort];
    out.sort(by);
    // The loadout (main, then secondary) always leads the bag.
    const rank = (d) => (d.id === i.equipped ? 2 : d.id === i.secondary ? 1 : 0);
    out.sort((a, b) => rank(b.dna) - rank(a.dna));
    return out.map(({ dna }) => dna);
  }

  function selectedDna() {
    return game.findWeapon(selected);
  }

  function select(id, { scrollDetail = false } = {}) {
    selected = id;
    bulk = false;
    game.markSeen(id);
    rerender();
    if (scrollDetail && matchMedia('(max-width: 800px)').matches) {
      document.querySelector('.inventory-panel .inv-detail')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // --- Actions -------------------------------------------------------------------

  function equip(dna, slot = 'main') {
    if (dna && game.equip(dna.id, slot)) game.toast(`${dna.name.text} is now your ${slot === 'secondary' ? 'secondary' : 'main'} weapon`);
  }

  function move(dna) {
    if (!dna) return;
    const inBag = inv().bag.some((w) => w.id === dna.id);
    game.moveWeapon(dna.id, inBag ? 'storage' : 'bag');
  }

  function favorite(dna) {
    if (!dna) return;
    game.toggleFavorite(dna.id);
    rerender();
  }

  async function salvage(dna) {
    if (!dna || game.inLoadout(dna.id) || inv().favorites.includes(dna.id)) return;
    const value = salvageValue(dna);
    const sure = await askConfirm({
      title: 'Salvage weapon?', icon: 'scrap', ok: 'Salvage', danger: true,
      text: `Salvage ${dna.name.text} for ${value.scrap} scrap and ${value.essence} essence?`,
    });
    if (!sure || !game.findWeapon(dna.id)) return;
    const list = visible(tab);
    const at = list.findIndex((w) => w.id === dna.id);
    game.salvage(dna.id);
    const rest = visible(tab);
    selected = rest[Math.min(at, rest.length - 1)]?.id ?? null;
    rerender();
  }

  // --- Pieces --------------------------------------------------------------------

  function chipGroup(label, options, current, onPick) {
    return h('div.group', { role: 'group', 'aria-label': label },
      h('span.label', label),
      options.map(([id, text]) => h('button.chip', {
        class: id === current ? 'on' : null,
        'aria-pressed': String(id === current),
        onclick: () => onPick(id),
      }, text)));
  }

  function toolbar() {
    return h('div.inv-toolbar',
      chipGroup('Sort', SORTS, view.sort, (id) => {
        view.sort = id;
        rerender();
      }),
      chipGroup('Show', FILTERS, view.filter, (id) => {
        view.filter = id;
        rerender();
      }));
  }

  function bulkToggle() {
    return h('button.chip', {
      class: bulk ? 'on' : null,
      'aria-pressed': String(bulk),
      onclick: () => {
        bulk = !bulk;
        rerender();
      },
    }, icon('scrap', 16), 'Quick salvage');
  }

  function slotGrid(list, cap, total) {
    const i = inv();
    const slots = list.map((dna) => {
      const r = rarityInfo(data, dna.rarity);
      const equipped = dna.id === i.equipped;
      const second = dna.id === i.secondary;
      const isNew = i.unseen.includes(dna.id);
      const fav = i.favorites.includes(dna.id);
      return h('button.slot', {
        style: { '--rarity': r.color },
        class: [`r-${dna.rarity}`, dna.id === selected ? 'selected' : null, equipped || second ? 'equipped' : null].filter(Boolean).join(' '),
        'data-id': dna.id,
        'aria-label': `${dna.name.text}, ${summaryLine(data, dna)}${equipped ? ', main weapon' : second ? ', secondary weapon' : ''}${fav ? ', favorite' : ''}${isNew ? ', new' : ''}`,
        title: dna.name.text,
        onclick: () => select(dna.id, { scrollDetail: true }),
        ondblclick: () => equip(dna),
      },
      weaponIconEl(dna, 40),
      equipped ? h('span.badge-e', { title: 'Main weapon' }, '1') : second ? h('span.badge-e.two', { title: 'Secondary weapon' }, '2') : null,
      isNew ? h('span.badge-new', 'NEW') : null,
      fav ? h('span.badge-fav', icon('star', 14)) : null);
    });
    if (view.filter === 'all') {
      for (let k = total; k < Math.min(cap, total + 6); k++) slots.push(h('div.slot.empty', { 'aria-hidden': 'true' }));
    }
    return h('div.inv-grid', { role: 'listbox', 'aria-label': 'Weapons' }, slots);
  }

  function details(dna) {
    if (!dna) {
      return h('div.empty-state', icon('sword', 48), h('p', 'Select a weapon to see its Weapon DNA.'));
    }
    const i = inv();
    const inBag = i.bag.some((w) => w.id === dna.id);
    const main = i.equipped === dna.id;
    const second = i.secondary === dna.id;
    const equipped = main || second;
    const fav = i.favorites.includes(dna.id);
    const value = salvageValue(dna);
    // A Workshop weapon can't be rolled again from its seed: its code carries all of it.
    const codeOf = async () => (dna.custom ? encodeWeaponCode(dna) : encodeDnaCode(dna));
    return h('div.inv-detail',
      weaponCard(data, dna, { compareTo: game.weapon?.dna?.id === dna.id ? null : game.weapon?.dna, compact: true }),
      h('div.actions',
        main
          ? h('button', { disabled: true }, h('span.slotnum', '1'), 'Main weapon')
          : h('button.btn-primary', { onclick: () => equip(dna, 'main') }, h('span.slotnum', '1'), second ? 'Make main' : 'Equip as main'),
        second
          ? h('button', { disabled: true }, h('span.slotnum', '2'), 'Secondary')
          : h('button', { onclick: () => equip(dna, 'secondary') }, h('span.slotnum', '2'), main ? 'Make secondary' : 'As secondary'),
        h('button', { disabled: equipped, onclick: () => move(dna) },
          icon(inBag ? 'chest' : 'bag', 20), inBag ? 'To storage' : 'To bag')),
      h('div.actions',
        h('button', { 'aria-pressed': String(fav), onclick: () => favorite(dna) },
          icon('star', 20), fav ? 'Unfavorite' : 'Favorite'),
        h('button.btn-danger', {
          disabled: equipped || fav,
          title: fav ? 'Favorites are protected from salvage' : null,
          onclick: () => salvage(dna),
        }, icon('scrap', 20), `Salvage +${value.scrap}/${value.essence}`),
        h('button', {
          title: 'A short code that rebuilds this exact weapon on any device',
          onclick: async () => {
            const code = await codeOf();
            try {
              if (navigator.share && game.input.mode === 'touch') await navigator.share({ title: dna.name.text, text: code });
              else await navigator.clipboard.writeText(code);
              game.toast('Weapon code copied');
            } catch {
              showText({ title: 'Weapon code', text: 'Copy this code to rebuild the weapon on any device.', value: code });
            }
          },
        }, 'Share code'),
        app?.openWorkshop && !game.mp ? h('button', {
          title: 'Open a copy of this weapon in the Weapon Workshop',
          onclick: () => app.openWorkshop({ dna }),
        }, icon('anvil', 20), 'Workshop') : null));
  }

  function bulkPanel(which) {
    const i = inv();
    const list = which === 'bag' ? i.bag : i.storage;
    const tiers = data.rarities.slice(0, 3);
    const idx = (dna) => data.rarityIndex.get(dna.rarity) ?? 0;
    const rows = tiers.map((r, n) => {
      const pick = list.filter((d) => idx(d) <= n && !game.inLoadout(d.id) && !i.favorites.includes(d.id));
      const total = pick.reduce((s, d) => {
        const v = salvageValue(d);
        return { scrap: s.scrap + v.scrap, essence: s.essence + v.essence };
      }, { scrap: 0, essence: 0 });
      return h('button', {
        disabled: !pick.length,
        onclick: async () => {
          const sure = await askConfirm({
            title: 'Salvage weapons?', icon: 'scrap', ok: `Salvage ${pick.length}`, danger: true,
            text: `Salvage ${pick.length} weapons (${r.name} and below) for ${total.scrap} scrap and ${total.essence} essence?`,
          });
          if (!sure) return;
          game.salvageMany(pick.map((d) => d.id));
          bulk = false;
          if (!game.findWeapon(selected)) selected = i.equipped;
          rerender();
        },
      }, h('span', { style: { color: r.color } }, `${r.name}${n ? ' and below' : ''}`),
      h('span.muted', ` · ${pick.length} weapons · +${total.scrap}`), icon('scrap', 16), `+${total.essence}`, icon('essence', 16));
    });
    return h('div.inv-detail.framed.bulk',
      h('h3', 'Quick salvage'),
      h('p.small.muted', `Salvages every weapon in your ${which} up to the chosen rarity. Your main and secondary weapons and your favorites (★) are never salvaged.`),
      h('div.menu', rows),
      h('button', { onclick: () => { bulk = false; rerender(); } }, 'Cancel'));
  }

  function inventoryTab(which) {
    const i = inv();
    const all = which === 'bag' ? i.bag : i.storage;
    const cap = which === 'bag' ? i.bagSize : i.storageSize;
    const list = visible(which);
    if (!list.some((w) => w.id === selected)) selected = list[0]?.id ?? null;
    const dna = list.find((w) => w.id === selected) ?? null;
    return h('div',
      toolbar(),
      h('div.inv-layout',
        h('div.inv-left',
          h('div.inv-count',
            h('span', `${all.length} / ${cap} slots${view.filter !== 'all' ? ` · ${list.length} shown` : ''}`),
            all.length ? bulkToggle() : null),
          all.length
            ? (list.length ? slotGrid(list, cap, all.length) : h('div.empty-state', h('p', 'No weapons match this filter.')))
            : h('div.empty-state', icon(which === 'bag' ? 'bag' : 'chest', 48),
              h('p', which === 'bag' ? 'Your bag is empty. Defeat enemies and open chests to find weapons.' : 'Nothing in storage yet. Move weapons here from your bag.'))),
        bulk ? bulkPanel(which) : details(dna)),
      h('div.keys',
        h('span', h('kbd', '←↑↓→'), ' select'), h('span', h('kbd', 'Enter'), '/', h('kbd', '1'), ' main'), h('span', h('kbd', '2'), ' secondary'),
        h('span', h('kbd', 'T'), ' bag/storage'), h('span', h('kbd', 'F'), ' favorite'),
        h('span', h('kbd', 'X'), ' salvage'), h('span', h('kbd', 'Q'), '/', h('kbd', 'E'), ' tabs')));
  }

  function characterTab() {
    const rows = statSheet(data, game.pstats);
    const pl = game.save.player;
    const camp = baseBonuses(data, game.save);
    const campRows = [
      camp.maxHpPct ? ['Hearth', `+${camp.maxHpPct}% Health`] : null,
      camp.attackPower || camp.defense ? ['Training Grounds', `+${camp.attackPower} Attack · +${camp.defense} Defense`] : null,
      camp.craftLevel ? ['Forge', `+${camp.craftLevel} crafted item level`] : null,
    ].filter(Boolean);
    return h('div.character',
      h('div.framed',
        h('h3', 'Stats'),
        h('dl.stats', rows.map(([k, v]) => [h('dt', k), h('dd', v)])),
        h('p.small.muted', 'No stamina — sprint as much as you like.')),
      h('div.framed',
        h('h3', 'Journey'),
        h('dl.stats.small',
          h('dt', 'Level'), h('dd', String(pl.level)),
          h('dt', 'Enemies defeated'), h('dd', String(pl.kills)),
          h('dt', 'Bosses defeated'), h('dd', String(Object.values(game.save.bosses.defeated).reduce((a, b) => a + b, 0))),
          h('dt', 'Play time'), h('dd', `${Math.floor(pl.playTime / 60)} min`)),
        campRows.length ? h('h3', 'Camp bonuses') : null,
        campRows.length ? h('dl.stats.small', campRows.map(([k, v]) => [h('dt', k), h('dd', v)])) : null));
  }

  function codexTab() {
    const codex = game.save.codex;
    const entries = Object.entries(codex.weapons).sort((a, b) => b[1].at - a[1].at);
    const input = h('input', { type: 'text', placeholder: 'Paste a weapon code (PGW1.… or a Workshop PGX1.…)', 'aria-label': 'Weapon code' });
    const preview = async (inputs) => {
      try {
        const dna = await game.weapons.regenerate(inputs);
        if (inputs.data && inputs.data !== data.dataVersion) {
          game.toast(`Made with game data ${inputs.data}; rebuilt with ${data.dataVersion}, so details may differ.`, 'warn');
        }
        codexPreview = dna;
        rerender();
      } catch (err) {
        game.toast(err.message, 'warn');
      }
    };
    return h('div.codex',
      h('p', `${entries.length} weapons discovered · ${codex.modifiers.length} modifiers known · ${codex.abilities.length} abilities unlocked`),
      h('div.code-row', input, h('button', {
        onclick: async () => {
          const text = input.value.trim();
          try {
            if (text.startsWith('PGX')) {
              // A Workshop code carries the whole weapon.
              codexPreview = await decodeWeaponCode(data, text);
              rerender();
            } else {
              preview(decodeDnaCode(text));
            }
          } catch (err) {
            game.toast(err.message, 'warn');
          }
        },
      }, 'Preview')),
      codexPreview ? h('div.codex-preview', weaponCard(data, codexPreview, { compact: true }),
        h('p.muted', codexPreview.custom || codexPreview.ctx?.src === 'workshop' ? 'Made in the Weapon Workshop.' : 'Rebuilt from its seed — identical on every device with the same game version.'),
        h('button', { onclick: () => app.openWorkshop?.({ dna: codexPreview }) }, icon('anvil', 18), 'Open in the Workshop')) : null,
      h('ul.codex-list', entries.slice(0, 200).map(([, e]) => {
        const r = rarityInfo(data, e.rarity);
        return h('li', h('button.linkish', {
          style: { color: r.color },
          onclick: () => preview({ seed: e.seed, gen: e.gen, ctx: e.ctx, data: e.data }),
        }, e.name), h('span.muted', ` ${r.name} ${data.byId.archetypes.get(e.archetype)?.name ?? e.archetype}`));
      })));
  }

  function switchTab(id) {
    tab = id;
    bulk = false;
    if (id === 'bag' || id === 'storage') {
      const list = visible(id);
      if (!list.some((w) => w.id === selected)) selected = list[0]?.id ?? null;
    }
    rerender();
  }

  function build() {
    const i = inv();
    const counts = { bag: `${i.bag.length}/${i.bagSize}`, storage: `${i.storage.length}/${i.storageSize}` };
    const newIn = (list) => list.some((w) => i.unseen.includes(w.id));
    const tabs = h('div.tabs', { role: 'tablist' }, TABS.map(([id, label, ic]) => h('button.tab', {
      role: 'tab', 'aria-selected': String(id === tab), class: id === tab ? 'active' : null,
      onclick: () => switchTab(id),
    }, icon(ic, 20), h('span', label),
    counts[id] ? h('span.count', counts[id]) : null,
    (id === 'bag' && newIn(i.bag)) || (id === 'storage' && newIn(i.storage)) ? h('span.dot', { 'aria-label': 'new' }) : null)));
    let content;
    if (tab === 'bag' || tab === 'storage') content = inventoryTab(tab);
    else if (tab === 'character') content = characterTab();
    else content = codexTab();
    return h('div.inventory', tabs, content);
  }

  // --- Keyboard ------------------------------------------------------------------

  function gridColumns() {
    const slots = [...document.querySelectorAll('.inventory-panel .inv-grid .slot')];
    if (slots.length < 2) return 1;
    const top = slots[0].offsetTop;
    const n = slots.findIndex((s) => s.offsetTop !== top);
    return n < 0 ? slots.length : n;
  }

  function onKey(e) {
    if (!document.querySelector('.inventory-panel') || isDialogOpen()) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tabIds = TABS.map(([id]) => id);
    if (e.code === 'KeyQ' || e.code === 'KeyE') {
      e.preventDefault();
      const n = tabIds.indexOf(tab) + (e.code === 'KeyE' ? 1 : -1);
      switchTab(tabIds[(n + tabIds.length) % tabIds.length]);
      return;
    }
    if (tab !== 'bag' && tab !== 'storage') return;
    const list = visible(tab);
    const at = list.findIndex((w) => w.id === selected);
    const dna = selectedDna();
    const cols = gridColumns();
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (step !== undefined && list.length) {
      e.preventDefault();
      const next = Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at + step)));
      focusGrid = true;
      select(list[next].id);
      return;
    }
    const inGrid = e.target instanceof Element && e.target.closest('.inv-grid');
    if (e.key === 'Enter' && (inGrid || e.target === document.body)) {
      e.preventDefault();
      equip(dna);
    } else if (e.code === 'Digit1' || e.code === 'Digit2') {
      e.preventDefault();
      equip(dna, e.code === 'Digit2' ? 'secondary' : 'main');
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      move(dna);
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      favorite(dna);
    } else if (e.code === 'KeyX' || e.key === 'Delete') {
      e.preventDefault();
      salvage(dna);
    }
  }

  const off = game.on('inventory', () => rerender());
  addEventListener('keydown', onKey);
  openModal({
    title: 'Inventory', icon: 'bag', body: build(), className: 'wide inventory-panel',
    onDispose: () => {
      off();
      removeEventListener('keydown', onKey);
    },
  });
  if (selected) game.markSeen(selected);
}
