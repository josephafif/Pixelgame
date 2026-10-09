// Market panel: buy from the traders, sell to them, or trade one of your
// weapons in against theirs. Everything costs gold; prices are steep so
// markets help without carrying you.

import { h } from './dom.js';
import { icon, costChip, resourceIcon, RESOURCE_NAMES } from './icons.js';
import { openModal, replaceModalBody } from './modal.js';
import { weaponCard, weaponIconEl } from './weapon-card.js';
import { marketStock, weaponPrice, sellPrice, SELL_BUNDLES } from '../game/markets.js';
import { rarityInfo, summaryLine } from '../weapons/describe.js';

const LAYOUT_NAMES = { bazaar: 'Walled bazaar', fort: 'Hill fort', palisade: 'Palisade camp', oasis: 'Oasis post' };

// Generated stock weapons, per market + period + slot.
const weaponCache = new Map();

export function open(game, app, { marketId } = {}) {
  const m = game.world.marketById(marketId);
  if (!m) return;
  const { data } = game;
  let tab = 'buy';
  let details = null; // index of the expanded stock weapon
  let tradeFor = null; // index of the stock weapon being traded for
  let stock = marketStock(data, game.save, m);

  const rerender = () => {
    const body = document.querySelector('.market-panel .panel-body');
    const scroll = body?.scrollTop ?? 0;
    replaceModalBody(build());
    if (body) body.scrollTop = scroll;
  };
  const key = (i) => `${m.id}:${stock.period}:${i}`;

  function ensureWeapons() {
    stock.items.forEach((item, i) => {
      if (item.kind !== 'weapon' || weaponCache.has(key(i))) return;
      weaponCache.set(key(i), null);
      game.weapons.generate(item.request).then((dna) => {
        weaponCache.set(key(i), dna);
        rerender();
      }).catch(() => weaponCache.delete(key(i)));
    });
  }

  const gold = () => game.save.resources.gold ?? 0;
  const hostile = () => game.markets.isHostile(m.id);
  const act = (fn) => {
    try {
      const msg = fn();
      if (msg) game.toast(msg);
    } catch (err) {
      game.toast(err.message, 'warn');
    }
    rerender();
  };

  function head() {
    const mins = Math.max(1, Math.ceil((stock.restockAt - Date.now()) / 60000));
    return h('div.market-head',
      h('div.market-title', { style: { '--mcolor': m.color } }, h('span.flag'), m.town
        ? 'Traders on the town square · up to rare'
        : `${LAYOUT_NAMES[m.layout] ?? 'Trading post'} · ${game.world.biomeById.get(m.biome)?.name ?? 'Wilds'}`),
      h('span.cost.gold', { title: 'Gold' }, icon('coin', 20), gold().toLocaleString()),
      h('span.small.muted', `New stock in ${mins} min`),
      hostile() ? h('p.market-hostile', icon('skull', 16), ` Nobody here will trade with you for ${Math.ceil(game.markets.hostileSecondsLeft(m.id) / 60)} more minutes.`) : null);
  }

  function weaponRow(item, i) {
    const dna = weaponCache.get(key(i));
    const bought = game.markets.isBought(m.id, stock.period, i);
    if (!dna) return h('li.mrow', h('div.mart', icon('sword', 32)), h('div.minfo', h('b', 'Unpacking…')));
    const r = rarityInfo(data, dna.rarity);
    const price = weaponPrice(dna, item.markup);
    return h('li.mrow', { class: `r-${dna.rarity}`, style: { '--rarity': r.color } },
      h('div.mart', weaponIconEl(dna, 40)),
      h('div.minfo',
        h('b', { style: { color: r.color } }, dna.name.text),
        h('span.small.muted', summaryLine(data, dna))),
      h('div.mbuy',
        bought ? h('span.badge', 'Sold') : costChip('gold', price, gold()),
        bought ? null : h('button.btn-primary', {
          disabled: hostile() || gold() < price,
          onclick: () => act(() => `Bought ${dna.name.text} for ${game.markets.buy(m, stock, i, { dna })} gold`),
        }, 'Buy'),
        bought ? null : h('button', { disabled: hostile(), onclick: () => { tradeFor = i; rerender(); } }, 'Trade in…'),
        h('button.linkish', { onclick: () => { details = details === i ? null : i; rerender(); } }, details === i ? 'Hide' : 'Details')),
      details === i ? h('div.mdetail', weaponCard(data, dna, { compareTo: game.weapon?.dna, compact: true })) : null);
  }

  function simpleRow(item, i, art, title, sub) {
    const bought = game.markets.isBought(m.id, stock.period, i);
    return h('li.mrow',
      h('div.mart', art),
      h('div.minfo', h('b', title), sub ? h('span.small.muted', sub) : null),
      h('div.mbuy',
        bought ? h('span.badge', 'Sold') : costChip('gold', item.price, gold()),
        bought ? null : h('button.btn-primary', {
          disabled: hostile() || gold() < item.price,
          onclick: () => act(() => { game.markets.buy(m, stock, i); return `Bought ${title}`; }),
        }, 'Buy')));
  }

  function buyTab() {
    ensureWeapons();
    return h('ul.market-list', stock.items.map((item, i) => {
      switch (item.kind) {
        case 'weapon': return weaponRow(item, i);
        case 'bundle': return simpleRow(item, i, resourceIcon(item.res, 32), `${item.qty} ${RESOURCE_NAMES[item.res] ?? item.res}`);
        case 'component': {
          const c = data.byId.components.get(item.id);
          return simpleRow(item, i, icon('book', 32), c?.name ?? item.id, c?.desc);
        }
        case 'shard': return simpleRow(item, i, icon('shard', 32), 'Star Shard', 'Needed for the Golden Catalyst. Very rare.');
        default: return null;
      }
    }));
  }

  function tradePicker() {
    const item = stock.items[tradeFor];
    const theirs = weaponCache.get(key(tradeFor));
    if (!theirs) return null;
    const price = weaponPrice(theirs, item.markup);
    const mine = game.allWeapons().filter((w) => !game.inLoadout(w.id));
    return h('div.trade-picker.framed',
      h('h3', 'Trade in for ', h('span', { style: { color: rarityInfo(data, theirs.rarity).color } }, theirs.name.text)),
      h('p.small.muted', 'Pick one of your weapons. Its trade-in value comes off the price.'),
      mine.length ? h('ul.market-list', mine.map((w) => {
        const credit = sellPrice(w);
        const pay = Math.max(0, price - credit);
        return h('li.mrow',
          h('div.mart', weaponIconEl(w, 32)),
          h('div.minfo', h('b', { style: { color: rarityInfo(data, w.rarity).color } }, w.name.text), h('span.small.muted', `Worth ${credit} gold here`)),
          h('div.mbuy',
            costChip('gold', pay, gold()),
            h('button.btn-primary', {
              disabled: gold() < pay,
              onclick: () => act(() => {
                game.markets.buy(m, stock, tradeFor, { dna: theirs, tradeInId: w.id });
                tradeFor = null;
                return `Traded ${w.name.text} for ${theirs.name.text}`;
              }),
            }, 'Trade')));
      })) : h('p', 'You have no weapons to trade (your loadout is kept).'),
      h('button', { onclick: () => { tradeFor = null; rerender(); } }, 'Cancel'));
  }

  function sellTab() {
    const mine = game.allWeapons().filter((w) => !game.inLoadout(w.id));
    const res = game.save.resources;
    return h('div',
      h('h3.mh', 'Weapons'),
      mine.length ? h('ul.market-list', mine.map((w) => {
        const r = rarityInfo(data, w.rarity);
        const fav = game.save.inventory.favorites.includes(w.id);
        return h('li.mrow', { class: `r-${w.rarity}`, style: { '--rarity': r.color } },
          h('div.mart', weaponIconEl(w, 32)),
          h('div.minfo', h('b', { style: { color: r.color } }, w.name.text), h('span.small.muted', summaryLine(data, w))),
          h('div.mbuy',
            costChip('gold', sellPrice(w)),
            h('button', {
              disabled: hostile(),
              title: fav ? 'This is a favorite' : null,
              onclick: () => {
                if (fav && !confirm(`${w.name.text} is a favorite. Sell it anyway?`)) return;
                if (w.rarity === 'legendary' && !confirm(`Sell your legendary ${w.name.text} for ${sellPrice(w)} gold?`)) return;
                act(() => `Sold ${w.name.text} for ${game.markets.sellWeapon(m, w.id)} gold`);
              },
            }, 'Sell')));
      })) : h('p.muted', 'Nothing to sell — your main and secondary weapons stay with you.'),
      h('h3.mh', 'Materials'),
      h('ul.market-list', SELL_BUNDLES.map((b) => h('li.mrow',
        h('div.mart', resourceIcon(b.res, 32)),
        h('div.minfo', h('b', `${b.qty} ${RESOURCE_NAMES[b.res]}`), h('span.small.muted', `You have ${res[b.res] ?? 0}`)),
        h('div.mbuy',
          costChip('gold', b.price),
          h('button', {
            disabled: hostile() || (res[b.res] ?? 0) < b.qty,
            onclick: () => act(() => `Sold ${b.qty} ${b.res} for ${game.markets.sellBundle(m, b)} gold`),
          }, 'Sell'))))));
  }

  function build() {
    // Stock rotates while the panel is open.
    if (Date.now() >= stock.restockAt) stock = marketStock(data, game.save, m);
    const tabs = h('div.tabs', { role: 'tablist' },
      h('button.tab', { class: tab === 'buy' ? 'active' : null, onclick: () => { tab = 'buy'; tradeFor = null; rerender(); } }, icon('coin', 20), 'Buy'),
      h('button.tab', { class: tab === 'sell' ? 'active' : null, onclick: () => { tab = 'sell'; tradeFor = null; rerender(); } }, icon('bag', 20), 'Sell'));
    return h('div.market', head(), tabs, tradeFor !== null ? tradePicker() : tab === 'buy' ? buyTab() : sellTab());
  }

  const off = game.on('inventory', () => rerender());
  openModal({ title: m.name, icon: 'coin', body: build(), className: 'wide market-panel', onDispose: off });
}

