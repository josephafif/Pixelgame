// The Weapon Tree (docs/WEAPON-EVOLUTION.md): pick one of your weapons and
// see its tree, the five steps from left to right (rows on a phone). Every
// step shows how the weapon would look, what it needs (with a hint where to
// find what you lack) and what it costs; the next step can be taken here.
// Steps of other branches stay visible, greyed, so you can plan. What you
// haven't found yet stays a secret: only where to look is told.
//
// Single player and multiplayer alike (game.evolve / game.temper; in
// multiplayer the server checks and answers, at the forge you stand at).

import { h } from './dom.js';
import { icon, costChips } from './icons.js';
import { openModal, replaceModalBody, isModalOpen } from './modal.js';
import { weaponCard, weaponIconEl } from './weapon-card.js';
import { rarityInfo, archetypeName, elementName } from '../weapons/describe.js';
import {
  familyOf, treeFor, nodeStatus, requirementsOf, costOf, evolveBlockers, previewNode, temperInfo, evoSummary, tierDef,
} from '../weapons/evolution.js';
import { dnaKey } from '../weapons/dna.js';

const STATUS_TEXT = { owned: 'Done', next: 'Next step', closed: 'Another path', future: 'Later' };

// The weapon last looked at (per session).
let lastId = null;

export function open(game, app, arg = {}) {
  const { data } = game;
  let id = arg.id ?? lastId ?? game.save.inventory.equipped;
  let nodeId = null;
  let busy = false;
  const previews = new Map();

  const weapons = () => game.allWeapons().filter((w) => familyOf(data, w));
  const current = () => game.findWeapon(id);
  if (!current() || !familyOf(data, current())) id = weapons()[0]?.id ?? null;

  function preview(dna, node) {
    const key = `${dnaKey(dna)}|${node.id}`;
    if (!previews.has(key)) previews.set(key, node.hidden ? null : previewNode(data, dna, node.id));
    return previews.get(key);
  }

  const rerender = () => {
    if (!isModalOpen()) return;
    const body = document.querySelector('.evolution-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    const after = document.querySelector('.evolution-panel .panel-body');
    if (after) after.scrollTop = scroll;
  };

  // --- Pieces ------------------------------------------------------------------------------

  function strip() {
    const list = weapons();
    if (list.length < 2) return null;
    const inv = game.save.inventory;
    return h('div.evo-strip', { role: 'listbox', 'aria-label': 'Your weapons' },
      list.map((w) => {
        const s = evoSummary(data, w);
        return h('button.slot', {
          class: [`r-${w.rarity}`, w.id === id ? 'selected' : null, w.id === inv.equipped || w.id === inv.secondary ? 'equipped' : null].filter(Boolean).join(' '),
          style: { '--rarity': rarityInfo(data, w.rarity).color },
          title: `${w.name.text} (${s.tierName})`,
          'aria-label': `${w.name.text}, ${s.tierName}`,
          'aria-selected': String(w.id === id),
          onclick: () => {
            id = w.id;
            lastId = id;
            nodeId = null;
            rerender();
          },
        }, weaponIconEl(w, 40), s.tier ? h('span.badge-tier', String(s.tier)) : null);
      }));
  }

  function head(dna) {
    const s = evoSummary(data, dna);
    const r = rarityInfo(data, dna.rarity);
    const path = [s.family.name, s.tierName, s.branchName, s.element ? elementName(data, s.element) : null].filter(Boolean).join(' · ');
    return h('div.evo-head', { style: { '--rarity': r.color } },
      h('div.card-icon', weaponIconEl(dna, 64)),
      h('div.evo-title',
        h('h3.weapon-name', dna.name.text),
        h('div.evo-rarity', `${r.name.toUpperCase()} · ${archetypeName(data, dna.archetype)}`),
        h('div.subtitle', path),
        h('div.tier-pips', { 'aria-label': `Step ${s.tier} of 5` }, [1, 2, 3, 4, 5].map((t) => h('i', { class: t <= s.tier ? 'on' : null })))),
      temperBox(dna, s));
  }

  function temperBox(dna, s) {
    const info = temperInfo(data, dna, game.save.player.level);
    const res = game.save.resources;
    let body;
    if (info.cost) {
      const short = Object.entries(info.cost).some(([k, v]) => (res[k] ?? 0) < v);
      body = [
        h('div.small', `Temper to level ${info.to}`),
        h('div.cost-row', costChips(info.cost, res)),
        h('button', { disabled: busy || short, onclick: () => act(() => game.temper(dna.id)) }, icon('hammer', 18), 'Temper'),
      ];
    } else {
      body = h('div.small.muted', info.from >= info.cap
        ? `At its cap for this step: evolve it to raise the cap to level ${data.evolution.levelCaps[Math.min(s.tier + 1, 5)]}.`
        : 'Tempered to your level. Level up to temper it further.');
    }
    return h('div.evo-temper.framed',
      h('div.level', `Level ${s.level}`, h('span.muted', ` / ${s.cap}`)),
      body);
  }

  function nodeIcon(dna, node) {
    if (node.hidden) return h('span.evo-glyph', '?');
    if (node.kind === 'infusion') {
      const el = data.byId.elements.get(node.element);
      return h('span.evo-gem', { style: { '--gem': el?.glow ?? el?.palette?.[0] ?? '#ffffff' } });
    }
    if (node.kind === 'awakening') return icon('star', 32);
    if (node.kind === 'temper') return icon('hammer', 32);
    const p = preview(dna, node);
    return p ? weaponIconEl(p, 40) : icon('sword', 32);
  }

  function nodeButton(dna, node) {
    const status = node.hidden ? 'future' : nodeStatus(data, dna, node);
    const sub = node.kind === 'form' ? node.archetypeName
      : node.kind === 'mastery' ? (node.archetypeName ?? 'Masterwork')
        : node.kind === 'infusion' ? 'Infusion'
          : node.kind === 'awakening' ? (node.hidden ? 'Infuse it first' : 'Legendary power') : 'Forge';
    return h('button.evo-node', {
      class: [`s-${status}`, node.id === nodeId ? 'on' : null, node.hidden ? 's-hidden' : null].filter(Boolean).join(' '),
      'aria-pressed': String(node.id === nodeId),
      'aria-label': `${node.name}, ${sub}: ${STATUS_TEXT[status]}`,
      title: `${node.name} (${STATUS_TEXT[status]})`,
      onclick: () => {
        nodeId = node.id;
        rerender();
        if (matchMedia('(max-width: 820px)').matches) {
          document.querySelector('.evolution-panel .evo-detail')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      },
    },
    h('span.evo-art', nodeIcon(dna, node)),
    h('span.evo-name', node.name),
    h('span.evo-sub', sub),
    status === 'owned' ? h('span.evo-check', '✓') : null);
  }

  function tree(dna, nodes) {
    const cols = [1, 2, 3, 4, 5].map((t) => {
      const list = nodes.filter((n) => n.tier === t);
      return h('div.evo-col',
        h('h4.step-title', h('span.num', String(t)), tierDef(data, t).name),
        h('div.evo-nodes', list.map((n) => nodeButton(dna, n))));
    });
    return h('div.evo-tree', cols);
  }

  /** A requirement row: met (✓) or not (✗), with where to look for what you lack. */
  function reqRow(row, node, status) {
    let label = row.label;
    let hint = null;
    if (row.kind === 'component') {
      const found = (game.save.components?.[row.id]?.found ?? 0) > 0;
      // Not found yet and not the very next step: keep the secret, tell where to look.
      if (!found && status !== 'next') label = 'An unknown find';
      if (!row.ok && row.hint) {
        hint = row.hint.boss
          ? `Carried by ${found || status === 'next' ? row.hint.bossName : 'the boss'} of ${row.hint.biomeName}`
          : row.hint.biomeNames?.length ? `Found in ${row.hint.biomeNames.join(' or ')}` : null;
      }
    }
    return h('li', { class: row.ok ? 'ok' : 'no' },
      h('span.mark', row.ok ? '✓' : '✗'),
      h('span', label, hint ? h('span.hint', ` — ${hint}`) : null));
  }

  function detail(dna, node) {
    if (!node) return null;
    if (node.hidden) {
      return h('div.evo-detail.framed',
        h('h3', 'Awakening'),
        h('p', node.desc),
        h('p.small.muted', 'Each element awakens its own legendary powers. Infuse the weapon to see which.'));
    }
    const status = nodeStatus(data, dna, node);
    const ctx = game.evolveCtx;
    const rows = requirementsOf(data, game.save, dna, node, ctx);
    const { cost } = costOf(data, game.save, node);
    const blockers = status === 'next' ? evolveBlockers(data, game.save, dna, node.id, ctx) : [];
    const p = status === 'next' || status === 'future' ? preview(dna, node) : null;
    const kind = { temper: 'Forge step', form: `New form: ${node.archetypeName}`, mastery: 'Masterwork', infusion: 'Infusion', awakening: 'Awakening' }[node.kind];
    const atForge = ctx.atForge !== false;
    let action;
    if (status === 'owned') action = h('p.evo-state.ok', '✓ Your weapon has taken this step.');
    else if (status === 'closed') action = h('p.evo-state.muted', 'Another path was chosen for this weapon.');
    else if (status === 'future') action = h('p.evo-state.muted', 'Take the steps before it first.');
    else if (!atForge) action = h('p.evo-state.warn', 'Go to a forge (your clan\'s, or Fristaden\'s for the first step) to evolve.');
    else {
      action = h('button.btn-primary.evo-go', {
        disabled: busy || blockers.length > 0,
        title: blockers[0] ?? null,
        onclick: () => act(() => game.evolve(dna.id, node.id)),
      }, icon('anvil', 20), `Evolve: ${node.name}`);
    }
    return h('div.evo-detail.framed',
      h('div.evo-detail-head',
        h('div',
          h('div.kind', kind),
          h('h3', node.name),
          h('p', node.desc))),
      h('div.evo-detail-grid',
        h('div',
          h('h4', 'Needs'),
          h('ul.evo-reqs', rows.map((row) => reqRow(row, node, status))),
          status !== 'owned' && status !== 'closed'
            ? [h('h4', 'Costs'), h('div.cost-row', costChips(cost, game.save.resources))]
            : null,
          action),
        p && (status === 'next' || status === 'future') ? h('details.evo-preview', { open: !matchMedia('(max-width: 820px)').matches || null },
          h('summary', 'What it becomes'),
          weaponCard(data, p, { compareTo: dna, compact: true })) : null));
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    rerender();
    try {
      await fn();
    } finally {
      busy = false;
      previews.clear();
      nodeId = null;
      rerender();
    }
  }

  function build() {
    const dna = current();
    if (!dna) {
      return h('div.empty-state', icon('anvil', 48),
        h('p', 'You have no weapon to grow yet. Find one: chests, ruins, buried treasure and bosses hold them.'));
    }
    const nodes = treeFor(data, dna);
    if (!nodeId || !nodes.some((n) => n.id === nodeId)) {
      nodeId = (nodes.find((n) => !n.hidden && nodeStatus(data, dna, n) === 'next') ?? nodes.filter((n) => nodeStatus(data, dna, n) === 'owned').pop() ?? nodes[0])?.id ?? null;
    }
    const node = nodes.find((n) => n.id === nodeId) ?? null;
    return h('div.evolution',
      strip(),
      head(dna),
      tree(dna, nodes),
      detail(dna, node),
      h('p.small.muted.evo-foot', 'Found weapons are rare at best: epic and legendary come from growing one here. '
        + 'Components only have to be found once; scrap, essence and the rest are spent. A chosen path is for good.'));
  }

  const off = game.on('inventory', () => {
    if (!busy) rerender();
  });
  openModal({ title: 'Weapon Tree', icon: 'anvil', body: build(), className: 'wide evolution-panel', onDispose: off });
}
