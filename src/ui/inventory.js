// Inventory (bag + storage), character sheet and weapon codex.

import { h } from './dom.js';
import { openModal, replaceModalBody } from './modal.js';
import { weaponCard, weaponIconEl } from './weapon-card.js';
import { statSheet } from '../game/stats.js';
import { encodeDnaCode, decodeDnaCode } from '../weapons/dna.js';
import { rarityInfo, summaryLine } from '../weapons/describe.js';
import { salvageValue } from '../game/loot.js';

const TABS = [['bag', 'Bag'], ['storage', 'Storage'], ['character', 'Character'], ['codex', 'Codex']];

export function open(game, app, initialTab = 'bag') {
  let tab = TABS.some(([id]) => id === initialTab) ? initialTab : 'bag';
  let selected = game.save.inventory.equipped;
  let codexPreview = null;

  const rerender = () => replaceModalBody(build());

  function slotGrid(list, cap) {
    const inv = game.save.inventory;
    const slots = list.map((dna) => {
      const r = rarityInfo(game.data, dna.rarity);
      return h('button.slot', {
        style: { '--rarity': r.color },
        class: `${dna.id === selected ? 'selected' : ''} ${dna.id === inv.equipped ? 'equipped' : ''}`,
        'aria-label': `${dna.name.text}, ${summaryLine(game.data, dna)}${dna.id === inv.equipped ? ', equipped' : ''}`,
        onclick: () => {
          selected = dna.id;
          rerender();
        },
      }, weaponIconEl(dna, 40));
    });
    for (let i = list.length; i < Math.min(cap, list.length + 6); i++) slots.push(h('div.slot.empty'));
    return h('div.inv-grid', slots);
  }

  function details(dna) {
    if (!dna) return h('p.muted', 'Select a weapon to see its DNA.');
    const inv = game.save.inventory;
    const inBag = inv.bag.some((w) => w.id === dna.id);
    const equipped = inv.equipped === dna.id;
    const value = salvageValue(dna);
    const code = encodeDnaCode(dna);
    return h('div.inv-details',
      weaponCard(game.data, dna, { compareTo: equipped ? null : game.weapon?.dna, compact: true }),
      h('div.actions',
        equipped ? h('button', { disabled: true }, 'Equipped') : h('button.btn-primary', { onclick: () => { game.equip(dna.id); rerender(); } }, 'Equip'),
        h('button', {
          disabled: equipped,
          onclick: () => { game.moveWeapon(dna.id, inBag ? 'storage' : 'bag'); rerender(); },
        }, inBag ? 'To storage' : 'To bag'),
        h('button.btn-danger', {
          disabled: equipped,
          onclick: () => {
            if (confirm(`Salvage ${dna.name.text} for ${value.scrap} scrap and ${value.essence} essence?`)) {
              game.salvage(dna.id);
              selected = null;
              rerender();
            }
          },
        }, 'Salvage'),
        h('button', {
          title: 'A short code that rebuilds this exact weapon on any device',
          onclick: async () => {
            try {
              if (navigator.share && game.input.mode === 'touch') await navigator.share({ title: dna.name.text, text: code });
              else await navigator.clipboard.writeText(code);
              game.toast('Weapon code copied');
            } catch {
              prompt('Weapon code', code);
            }
          },
        }, 'Share code')));
  }

  function inventoryTab(which) {
    const inv = game.save.inventory;
    const list = which === 'bag' ? inv.bag : inv.storage;
    const cap = which === 'bag' ? inv.bagSize : inv.storageSize;
    const dna = list.find((w) => w.id === selected) ?? null;
    return h('div.inv-layout',
      h('div.inv-left',
        h('div.inv-count', `${list.length} / ${cap}`),
        list.length ? slotGrid(list, cap) : h('p.muted', which === 'bag' ? 'Your bag is empty.' : 'Nothing in storage yet.')),
      h('div.inv-right', details(dna)));
  }

  function characterTab() {
    const rows = statSheet(game.data, game.pstats);
    const pl = game.save.player;
    return h('div.character',
      h('dl.stats', rows.map(([k, v]) => [h('dt', k), h('dd', v)])),
      h('p.muted', 'No stamina — sprint as much as you like.'),
      h('dl.stats.small',
        h('dt', 'Level'), h('dd', String(pl.level)),
        h('dt', 'Enemies defeated'), h('dd', String(pl.kills)),
        h('dt', 'Bosses defeated'), h('dd', String(Object.values(game.save.bosses.defeated).reduce((a, b) => a + b, 0))),
        h('dt', 'Play time'), h('dd', `${Math.floor(pl.playTime / 60)} min`)));
  }

  function codexTab() {
    const codex = game.save.codex;
    const entries = Object.entries(codex.weapons).sort((a, b) => b[1].at - a[1].at);
    const input = h('input', { type: 'text', placeholder: 'Paste a weapon code (PGW1.…)', 'aria-label': 'Weapon code' });
    const preview = async (inputs) => {
      try {
        const dna = await game.weapons.regenerate(inputs);
        if (inputs.data && inputs.data !== game.data.dataVersion) {
          game.toast(`Made with game data ${inputs.data}; rebuilt with ${game.data.dataVersion}, so details may differ.`, 'warn');
        }
        codexPreview = dna;
        rerender();
      } catch (err) {
        game.toast(err.message, 'warn');
      }
    };
    return h('div.codex',
      h('p', `${entries.length} weapons discovered · ${codex.modifiers.length} modifiers known · ${codex.abilities.length} abilities unlocked`),
      h('div.code-row', input, h('button', { onclick: () => {
        try {
          preview(decodeDnaCode(input.value.trim()));
        } catch (err) {
          game.toast(err.message, 'warn');
        }
      } }, 'Preview')),
      codexPreview ? h('div.codex-preview', weaponCard(game.data, codexPreview, { compact: true }),
        h('p.muted', 'Rebuilt from its seed — identical on every device with the same game version.')) : null,
      h('ul.codex-list', entries.slice(0, 200).map(([id, e]) => {
        const r = rarityInfo(game.data, e.rarity);
        return h('li', h('button.linkish', {
          style: { color: r.color },
          onclick: () => preview({ seed: e.seed, gen: e.gen, ctx: e.ctx, data: e.data }),
        }, e.name), h('span.muted', ` ${r.name} ${game.data.byId.archetypes.get(e.archetype)?.name ?? e.archetype}`));
      })));
  }

  function build() {
    const tabs = h('div.tabs', { role: 'tablist' }, TABS.map(([id, label]) => h('button.tab', {
      role: 'tab', 'aria-selected': String(id === tab), class: id === tab ? 'active' : '',
      onclick: () => {
        tab = id;
        rerender();
      },
    }, label)));
    let content;
    if (tab === 'bag' || tab === 'storage') content = inventoryTab(tab);
    else if (tab === 'character') content = characterTab();
    else content = codexTab();
    return h('div.inventory', tabs, content);
  }

  const off = game.on('inventory', () => rerender());
  openModal({ title: 'Inventory', body: build(), className: 'wide inventory-panel', onClose: off });
}

