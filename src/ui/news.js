// News: what the big update brings, shown from the main menu (a card with a
// NEW badge until you have read it) and the pause menu. Each item says
// whether it is out now or on its way; flip `live` as the parts land.

import { h } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { icon } from './icons.js';

/** Bump `id` when the news changes, so the NEW badge shows again. */
export const NEWS = {
  id: '2026-10-territories-1',
  title: { sv: 'Territorier och fraktioner', en: 'Territories and Factions' },
  teaser: {
    sv: 'Den största uppdateringen hittills är på väg: tre nya biomer, soldater, en strategikarta och fraktioner som för krig.',
    en: 'The biggest update yet is on its way: three new biomes, soldiers, a strategy map and factions at war.',
  },
  intro: {
    sv: 'Utforska, hitta ritningar, bygg upp basen, träna en armé och ta över världen, ett territorium i taget. Delarna kommer en i taget, i både singleplayer och multiplayer.',
    en: 'Explore, find blueprints, build up your base, train an army and take the world, one territory at a time. The parts land one by one, in single player and multiplayer alike.',
  },
  sections: [
    {
      icon: 'portal',
      title: { sv: 'Tre nya biomer', en: 'Three new biomes' },
      items: [
        {
          live: false,
          sv: '**Mireglass Fen**: ett lysande träsk med läkande svampar, giftmoln och bossen The Mireheart. Samla Lumen Spores.',
          en: '**Mireglass Fen**: a glowing swamp with healing fungi, poison clouds and the boss The Mireheart. Gather Lumen Spores.',
        },
        {
          live: false,
          sv: '**Prism Barrens**: en kristallöken där kristaller studsar skott. Bossen The Prism Warden, Prismite och förmågan Prism Split.',
          en: '**Prism Barrens**: a crystal desert where crystals bounce shots. The boss The Prism Warden, Prismite and the Prism Split power.',
        },
        {
          live: false,
          sv: '**Skyreach**: svävande öar där hästen hoppar mellan öarna. Vindströmmar, luftportaler, bossen The Aether Roc och Gale Step.',
          en: '**Skyreach**: floating islands your horse leaps between. Wind currents, sky portals, the boss The Aether Roc and Gale Step.',
        },
      ],
    },
    {
      icon: 'flag',
      title: { sv: 'Krig om territorier', en: 'War for territory' },
      items: [
        {
          live: false,
          sv: '**Soldater**: träna arbetare till vakter, infanterister, bågskyttar, ryttare och ingenjörer.',
          en: '**Soldiers**: train workers as guards, infantry, archers, riders and engineers.',
        },
        {
          live: false,
          sv: '**Strategikartan**: se världen ovanifrån och ge order till trupperna: flytta, försvara, anfalla, patrullera, retirera.',
          en: '**The strategy map**: see the world from above and order your squads: move, defend, attack, patrol, retreat.',
        },
        {
          live: false,
          sv: '**Territorier**: erövra utposter, försvara dem mot motanfall och ta tillbaka det du förlorat.',
          en: '**Territories**: take outposts, hold them against counterattacks and win back what you lose.',
        },
        {
          live: false,
          sv: '**NPC-fraktioner**: läger, fästen och högkvarter med egna arméer. De försvarar sig, expanderar och anfaller varandra, och dig.',
          en: '**NPC factions**: camps, strongholds and headquarters with armies of their own. They defend, expand and attack each other, and you.',
        },
      ],
    },
    {
      icon: 'star',
      title: { sv: 'Grafik och belöningar', en: 'Looks and rewards' },
      items: [
        {
          live: false,
          sv: '**Ny grafik**: mjukare ljus, skuggor och rikare mark och skog i hela världen. Kollisioner och regler är desamma.',
          en: '**New look**: softer light, shadows and richer ground and forests across the world. Collisions and rules stay the same.',
        },
        {
          live: false,
          sv: '**Sällsyntare ritningar**: vanliga kistor ger sällan ritningar, och de allra bästa får du bara av de svåraste bossarna.',
          en: '**Rarer blueprints**: common chests rarely give blueprints, and the very best only come from the hardest bosses.',
        },
      ],
    },
    {
      icon: 'hammer',
      title: { sv: 'Redan ute', en: 'Out already' },
      items: [
        {
          live: true,
          sv: 'Arbetare hittar ut genom porten när stugan står innanför murarna.',
          en: 'Workers find their way out through the gate when the lodge stands inside walls.',
        },
        {
          live: true,
          sv: 'Attackknappen träffar hajar och sjöormar från båten.',
          en: 'The attack button hits sharks and serpents from the boat.',
        },
        {
          live: false,
          sv: 'Hästar blir lättare att hitta. Byggen och underhåll blir dyrare.',
          en: 'Horses get easier to find. Building and upkeep cost more.',
        },
        {
          live: true,
          sv: 'Fuskskript kommer inte åt spelet längre. Servern har redan stoppat allt som skulle ge resurser, nivåer eller föremål.',
          en: 'Cheat scripts no longer reach the game. The server already stopped anything that would grant resources, levels or items.',
        },
      ],
    },
  ],
};

const SEEN_KEY = 'pg-news-seen';
const UI = {
  sv: { live: 'Ute nu', coming: 'På väg', more: 'Läs mer', close: 'Spännande!', badge: 'NYTT', lang: 'English' },
  en: { live: 'Out now', coming: 'Coming', more: 'Read more', close: 'Can\'t wait!', badge: 'NEW', lang: 'Svenska' },
};

let lang = /^sv\b/i.test(globalThis.navigator?.language ?? '') ? 'sv' : 'en';

export function newsLang() {
  return lang;
}

export function newsSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === NEWS.id;
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, NEWS.id);
  } catch {
    // (private mode: the badge just stays)
  }
}

/** **bold** in a line of news, as text nodes and <b>. */
function rich(text) {
  return text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? h('b', part) : part));
}

function body(onLang) {
  const t = UI[lang];
  return h('div.news',
    h('p.news-intro', NEWS.intro[lang]),
    NEWS.sections.map((s) => h('section.news-section',
      h('h3', icon(s.icon, 20), s.title[lang]),
      h('ul', s.items.map((it) => h(`li${it.live ? '.live' : ''}`,
        h(`span.news-chip${it.live ? '.live' : ''}`, it.live ? t.live : t.coming),
        h('span', rich(it[lang]))))))),
    h('div.news-actions',
      h('button', { onclick: onLang }, t.lang),
      h('button.btn-primary', { autofocus: true, onclick: () => closeModal() }, t.close)));
}

/** Opens the news (and marks it read). */
export function openNews({ onClose } = {}) {
  markSeen();
  const show = () => openModal({
    title: NEWS.title[lang], icon: 'star', className: 'news-panel', onClose,
    body: body(() => {
      lang = lang === 'sv' ? 'en' : 'sv';
      show();
    }),
  });
  show();
}

/** The main menu's news card: the headline, a teaser and a NEW badge until read. */
export function newsCard({ onOpen } = {}) {
  const t = UI[lang];
  const card = h('button.news-card', {
    type: 'button',
    onclick: () => {
      card.querySelector('.news-badge')?.remove();
      onOpen?.();
      openNews();
    },
  },
  newsSeen() ? null : h('span.news-badge', t.badge),
  h('span.news-card-title', icon('star', 20), NEWS.title[lang]),
  h('span.news-card-text', NEWS.teaser[lang]),
  h('span.news-card-more', `${t.more} →`));
  return card;
}
