// News: what the big update brings, shown from the main menu (a card with a
// NEW badge until you have read it) and the pause menu. Each item says
// whether it is out now or on its way; flip `live` as the parts land.

import { h } from './dom.js';
import { openModal, closeModal } from './modal.js';
import { icon } from './icons.js';

/** Bump `id` when the news changes, so the NEW badge shows again. */
export const NEWS = {
  id: '2026-10-combat-feel-1',
  title: { sv: 'Fjärrländerna', en: 'The Far Lands' },
  teaser: {
    sv: 'Nytt: laddslag som i Minecraft, färre monster, mindre lagg, levande skogar och dag och natt med varmt ljus från facklor och eldar.',
    en: 'New: charged blows as in Minecraft, fewer monsters, less lag, living forests, and day and night with the warm light of torches and fires.',
  },
  intro: {
    sv: 'Utforska långt ut, möt nya bossar, hitta ritningar och bygg upp basen. Allt finns i både singleplayer och multiplayer.',
    en: 'Explore far out, meet new bosses, find blueprints and build up your base. All of it in single player and multiplayer alike.',
  },
  sections: [
    {
      icon: 'sword',
      title: { sv: 'Strid och spelkänsla', en: 'Combat and feel' },
      items: [
        {
          live: true,
          sv: '**Laddslag** (som i Minecraft): svärd, hammare, piskor och spjut kan slå så ofta du vill, men slaget tar full skada först när vapnet laddats upp igen (en liten mätare under dig). Ett snabbt slag till tar mindre, och bara ett fullt laddat slag kan bli kritiskt, knuffa och sätta igång vapnets effekter. Håller du inne knappen slår du fulla slag i vapnets takt.',
          en: '**Charged blows** (as in Minecraft): swords, hammers, whips and spears swing as often as you like, but a blow only lands in full once the weapon has wound up again (a little bar under you). A quick extra swing hits softer, and only a fully wound blow can crit, knock back and set off the weapon\'s effects. Hold the button to swing full blows at the weapon\'s pace.',
        },
        {
          live: true,
          sv: '**Färre monster** i alla biomer, både på dagen och på natten (Prism Barrens har ännu färre), och de märker dig först när du kommer ganska nära.',
          en: '**Fewer monsters** in every biome, by day and by night (the Prism Barrens even fewer), and they only notice you when you come fairly close.',
        },
        {
          live: true,
          sv: '**Mindre lagg**: kristallfälten i Prism Barrens, siffror och namn i världen, och när monster dör och tappar loot. Meddelanden är mindre och ligger i högerkanten i stället för mitt i bilden, huvudmenyn passar alla skärmar (även telefon på sidan), och en ny version installeras direkt när du startar spelet i stället för att fråga varje gång.',
          en: '**Less lag**: the crystal fields of the Prism Barrens, numbers and names in the world, and when monsters die and drop loot. Notices are smaller and sit at the right edge instead of the middle of the view, the main menu fits every screen (a phone on its side too), and a new version installs as you start the game instead of asking every time.',
        },
      ],
    },
    {
      icon: 'wood',
      title: { sv: 'Skog, ljus och natt', en: 'Forests, light and night' },
      items: [
        {
          live: true,
          sv: '**Levande skogar**: träd i många former och storlekar i varje biom (ekar, barrträd, vindpinade träd på höglandet, träskträd), med buskar, ormbunkar, mossa och svamp runt fötterna. Du går bakom trädkronorna (de blir genomskinliga), stammarna är smalare så det är lätt att ta sig genom skogen, och träden gungar när någon går förbi.',
          en: '**Living forests**: trees in many shapes and sizes in every biome (oaks, pines, windswept highland trees, swamp trees), with bushes, ferns, moss and mushrooms round their feet. You walk behind the crowns (they turn see-through), the trunks are slimmer so forests are easy to get through, and trees sway when someone passes.',
        },
        {
          live: true,
          sv: '**Dag och natt**: ett dygn tar 24 minuter. Solnedgången färgar allt rött, och på natten blir det mörkt. Facklor, lägerelden, smedjan, lava, lumensvampar och kristaller lyser varmt runt sig. På natten strövar fler monster omkring, på dagen färre, och de skyr ljuset från facklor och eld (bossar bryr sig inte). Ställ ut facklor runt basen!',
          en: '**Day and night**: a day lasts 24 minutes. Sunset turns everything red, and at night it grows dark. Torches, the camp fire, the forge, lava, lumen caps and crystals glow warmly around them. At night more monsters roam, by day fewer, and they shun the light of torches and fire (bosses don\'t care). Put torches round your base!',
        },
        {
          live: true,
          sv: '**Röj för gott**: träd och stenar som du själv hugger ner eller bryter kommer inte tillbaka, så du kan röja skog och bygga där den stod. Det som arbetarna hugger planteras igen och växer upp.',
          en: '**Clear for good**: trees and rocks you cut down or mine yourself don\'t come back, so you can clear a forest and build where it stood. What your workers cut is replanted and grows back.',
        },
        {
          live: true,
          sv: 'J slår bara (E eller F använder saker och tar dig i båten). På datorn syns vapnets legendariska förmåga (Q) och rusningen (V) bredvid snabbfältet, med nedräkning. Inga svarta rutor flimrar längre när du hugger träd.',
          en: 'J only attacks (E or F uses things and takes you into the boat). On a computer the weapon\'s legendary power (Q) and the dash (V) show next to the hotbar, with their cooldowns. No more black boxes flickering when you chop trees.',
        },
      ],
    },
    {
      icon: 'portal',
      title: { sv: 'Tre nya biomer', en: 'Three new biomes' },
      items: [
        {
          live: true,
          sv: '**Mireglass Fen**: ett lysande träsk långt ute. Gyttjan saktar ner dig och gör dig sjuk, Mendblooms läker och Puffcaps släpper giftmoln när något slår dem (lura in monstren!). Boglings, Glowmoths, Mire Trolls och bossen The Mireheart. Samla Lumen Spores, hitta ritningen till Läketrädgården och brygg Lumen Tonic där.',
          en: '**Mireglass Fen**: a glowing swamp far out. Its bog slows you and makes you sick, Mendblooms heal and Puffcaps burst into poison clouds when anything hits them (lure the monsters in!). Boglings, Glowmoths, Mire Trolls and the boss The Mireheart. Gather Lumen Spores, find the Healing Garden blueprint and brew Lumen Tonic there.',
        },
        {
          live: true,
          sv: '**Prism Barrens**: en kristallöken långt ute (runt 350–400 rutor från lägret) där spegelkristaller studsar skott, även monstrens tillbaka mot dem själva. Shardlings, Refractors, Mirror Knights och bossen The Prism Warden med sina laserfält. Bryt Prismite, hitta Prism Lens för förmågan Prism Split, och bygg Prism Relay vid tornen.',
          en: '**Prism Barrens**: a crystal desert far out (about 350–400 tiles from camp) where mirror crystals bounce shots, even monsters\' shots back at them. Shardlings, Refractors, Mirror Knights and the boss The Prism Warden with its laser fields. Mine Prismite, find the Prism Lens for the Prism Split power, and build a Prism Relay by your turrets.',
        },
        {
          live: true,
          sv: '**Skyreach**: svävande öar i ett hav av moln. Gå över broarna, låt vindströmmarna bära dig, eller rid: hästen hoppar över smala glipor mellan öarna. Gale Sprites, Cloud Rays, Storm Griffins och bossen The Aether Roc. Bryt Aetherglass, lär dig **Gale Step** (V: en snabb rusning förbi attacker) och bygg en Vindfyr som gör dig snabbare.',
          en: '**Skyreach**: floating islands in a sea of clouds. Cross the bridges, ride the wind currents, or take your horse: it leaps the narrow gaps between islands. Gale Sprites, Cloud Rays, Storm Griffins and the boss The Aether Roc. Mine Aetherglass, learn **Gale Step** (V: a quick dash past attacks) and build a Wind Beacon that makes you quicker.',
        },
      ],
    },
    {
      icon: 'star',
      title: { sv: 'Grafik och belöningar', en: 'Looks and rewards' },
      items: [
        {
          live: true,
          sv: '**Ny grafik**: mjukare ljus, skuggor, täta trädkronor, strandkanter och rikare mark i hela världen. Kollisioner och regler är desamma (Inställningar → Graphics → Classic ger den gamla stilen).',
          en: '**New look**: softer light, shadows, dense tree crowns, shorelines and richer ground across the world. Collisions and rules stay the same (Settings → Graphics → Classic brings back the old look).',
        },
        {
          live: true,
          sv: '**Sällsyntare ritningar**: kistor och vanliga monster ger sällan ritningar, ruiner och bossar oftare. Legendariska ritningar (**Aegis Wall** och **Sunfire Obelisk**) får du bara av de svåraste bossarna: vid de stora altarna och i fjärrländerna. Första segern över varje boss ger en bestämd ritning, och en dubblett blir essens och skrot. Oddsen står i Loot odds.',
          en: '**Rarer blueprints**: chests and ordinary monsters rarely give blueprints, ruins and bosses more often. Legendary blueprints (the **Aegis Wall** and the **Sunfire Obelisk**) only come from the hardest bosses: at the great altars and in the far lands. The first win over each boss gives a set blueprint, and a duplicate turns into essence and scrap. The odds are in Loot odds.',
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
          live: true,
          sv: 'Fler hästflockar, närmare starten, och de syns på kartan (byborna vet var de betar). Byggen, arbetare och underhåll kostar mer.',
          en: 'More horse herds, closer to the start, and they show on the map (villagers know where they graze). Building, workers and upkeep cost more.',
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

/** The main menu's news card: the headline, a teaser and a NEW badge until read (then just a quiet button). */
export function newsCard({ onOpen } = {}) {
  const t = UI[lang];
  const card = h(`button.news-card${newsSeen() ? '.seen' : ''}`, {
    type: 'button',
    onclick: () => {
      card.querySelector('.news-badge')?.remove();
      card.classList.add('seen');
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
