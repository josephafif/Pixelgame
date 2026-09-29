// "NEW WEAPON DISCOVERED" screen (spec §16).

import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal, closeModal } from './modal.js';
import { weaponCard } from './weapon-card.js';

export function showDiscovery(game, { dna, canKeep, canStore, salvage, equipped }) {
  const choose = (choice) => {
    closeModal(true);
    game.resolveDiscovery(dna, choice);
  };
  const isFirst = !equipped;
  const rarity = game.data.byId.rarities.get(dna.rarity);
  const r = game.data.rarityIndex.get(dna.rarity) ?? 0;
  // Pixel confetti for epic and legendary finds.
  const confetti = r >= 3
    ? h('div.confetti', { 'aria-hidden': 'true' }, Array.from({ length: r >= 4 ? 28 : 14 }, (_, i) => h('i', {
      style: {
        left: `${(i * 37) % 100}%`,
        animationDelay: `${((i * 7) % 10) / 10}s`,
        animationDuration: `${1.6 + ((i * 3) % 7) / 10}s`,
        background: i % 3 ? rarity.color : '#ffffff',
      },
    })))
    : null;
  const body = h('div.discovery', { class: `r-${dna.rarity}`, style: { '--rarity': rarity?.color } },
    r >= 2 ? h('div.rays', { 'aria-hidden': 'true' }) : null,
    confetti,
    h('div.discovery-banner', { class: `r-${dna.rarity}`, 'aria-live': 'assertive' }, 'NEW WEAPON DISCOVERED'),
    h('div.rarity-ribbon', { class: `r-${dna.rarity}` }, h('span', rarity?.name.toUpperCase() ?? '')),
    weaponCard(game.data, dna, { compareTo: equipped }),
    h('div.actions',
      h('button.btn-primary', { onclick: () => choose('equip'), autofocus: true, disabled: !canKeep && !canStore }, icon('sword', 20), 'Equip'),
      isFirst ? null : h('button', { onclick: () => choose('keep'), disabled: !canKeep }, icon('bag', 20), canKeep ? 'Keep in bag' : 'Bag full'),
      isFirst ? null : h('button', { onclick: () => choose('storage'), disabled: !canStore }, icon('chest', 20), 'Send to storage'),
      isFirst ? null : h('button.btn-danger', { onclick: () => choose('salvage') },
        'Salvage', h('span.gain', `+${salvage.scrap}`, icon('scrap', 16), `+${salvage.essence}`, icon('essence', 16)))));
  openModal({ body, className: `discovery-panel r-${dna.rarity}`, locked: true, label: `New ${rarity?.name ?? ''} weapon discovered` });
}
