// "NEW WEAPON DISCOVERED" screen (spec §16).

import { h } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { weaponCard } from './weapon-card.js';

export function showDiscovery(game, { dna, canKeep, canStore, salvage, equipped }) {
  const choose = (choice) => {
    closeModal(true);
    game.resolveDiscovery(dna, choice);
  };
  const isFirst = !equipped;
  const body = h('div.discovery',
    h('div.discovery-banner', { 'aria-live': 'assertive' }, 'NEW WEAPON DISCOVERED'),
    weaponCard(game.data, dna, { compareTo: equipped }),
    h('div.actions',
      h('button.btn-primary', { onclick: () => choose('equip'), autofocus: true, disabled: !canKeep && !canStore }, 'Equip'),
      isFirst ? null : h('button', { onclick: () => choose('keep'), disabled: !canKeep }, canKeep ? 'Keep in bag' : 'Bag full'),
      isFirst ? null : h('button', { onclick: () => choose('storage'), disabled: !canStore }, 'Send to storage'),
      isFirst ? null : h('button.btn-danger', { onclick: () => choose('salvage') }, `Salvage (+${salvage.scrap}⚙ +${salvage.essence}◆)`)));
  openModal({ body, className: 'discovery-panel', locked: true, label: 'New weapon discovered' });
}
