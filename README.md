# Pixelgame: Infinite Arsenal

Ett pixel-actionrollspel där **varje vapen genereras procedurellt från sitt eget Weapon DNA**.
Spelet är en installerbar **Progressive Web App**: det går att spela direkt i webbläsaren eller
installera som app på mobil, surfplatta och desktop, och det fungerar helt offline efter första
besöket.

- Inga beroenden i körtid och inget byggsteg. Allt är vanliga ES-moduler som kan hostas statiskt.
- Vapengenerering i en **Web Worker**, med samma kod på huvudtråden som fallback.
- Deterministiskt: samma seed och kontext ger **exakt samma vapen på alla enheter**.
- Sparning i **IndexedDB** (med fallback), versionerat sparformat med migreringar,
  export/import och valfri molnsynk.

## Snabbstart

```bash
npm start            # utvecklingsserver på http://localhost:5173
npm test             # enhetstester (node:test, inga beroenden)
npm run build        # uppdaterar precache-manifest.js efter ändringar i appfiler
npm run check        # verifierar att precache-manifestet är aktuellt + enhetstester
npm install && npm run test:e2e   # Playwright: desktop, mobil (touch), offline och uppdatering
```

`?debug=1` exponerar `window.__pixelgame` för felsökning och e2e-tester.
`?sw=reset` avregistrerar Service Workern och rensar dess cachar. Sparfilen rörs aldrig.

## Kontroller

| Handling | Touch | Tangentbord / mus | Handkontroll |
| --- | --- | --- | --- |
| Rörelse (360°) | Vänster joystick | WASD / piltangenter | Vänster spak |
| Sikta | Automatiskt | Automatiskt | Automatiskt |
| Attack / Use | Svärdknappen (blir en hand nära kistor, byggnader m.m.) | Klick, Space, J (E/F = Use) | A / RT |
| Sprint (ingen stamina) | Stövelknappen (växla eller håll, valbart) | Shift | LB / L3 |
| Ability | Stjärnknappen (syns bara när vapnet har en) | Q, K eller högerklick | X |
| Inventory / Forge / Research / Läger / Meny | Knapparna uppe till höger | I / C / R / B / Esc | Y / Start / B |
| Byggläge (i lägret) | Hammarknappen | G (1–9 väljer, X river, Esc klar) | – |
| Hugga / bryta (med hacka) | Svärdknappen nära träd/sten | Space / E (håll inne) | A |

**Auto-aim:** vapnet siktar alltid själv. Det låser på närmaste fiende inom räckvidd (bossar
prioriteras, och låset släpper inte i onödan). Utan fiende pekar vapnet åt det håll du går.
Musen används bara för att klicka, så den drar aldrig vapnet åt fel håll.

Joysticken skalas efter skärmstorleken och kan ställas in (storlek, fast/dynamisk, vänsterhänt
layout). Spelytan har `touch-action: none`, så gester i spelet aldrig scrollar eller zoomar sidan.
Menyer och paneler går däremot att scrolla som vanligt.

**Webbläsaren håller sig ur vägen** (`src/pwa/harden.js`): ingen högerklicks- eller
långtrycksmeny, ingen textmarkering eller bilddragning, ingen zoom med Ctrl+hjul eller nyp,
inga Ctrl-genvägar som skriv ut/bokmärke/sök, och mittenklick/musens bakåtknapp gör inget.
Ctrl+S sparar spelet. Mobilens bakåtknapp stänger öppen panel eller öppnar pausmenyn; tryck
bakåt igen från pausmenyn för att lämna. Textfält (vapenkoder) fungerar som vanligt.

## Ekonomi och progression

Progressionen är medvetet långsammare än i första versionen:

- **Essence** droppar bara ibland från vanliga fiender (40 % chans, mer från elitfiender och
  bossar). Värdet växer långsamt med fiendens nivå.
- **Skrotning** ger lite: från 2 scrap för ett vanligt vapen till 24 scrap och 12 essence för ett
  legendariskt.
- **Crafting** kostar mer och blir dyrare med din nivå (+6 % per nivå); Forge-nivåer ger rabatt.
- **Catalysts:** Azure kräver Forge 2, Violet Forge 4 och Golden (legendariskt) Forge 5, en
  besegrad boss och 900 essence.
- **Byggnader** kostar också trä och sten från nivå 2, så du behöver samla material.

All balans ligger i `gamedata.json` (`crafting`, `catalysts`, `base`, `building`, `gathering`)
och i `src/game/loot.js`.

## Rarity syns direkt

Ett vapen på marken visar sin rarity på avstånd: vanliga glimmar, ovanliga lyser grönt,
sällsynta (rare) skickar upp en blå ljuspelare, episka en högre lila med kretsande gnistor, och
legendariska en hög guldpelare med roterande strålar. Rare och högre har rarity-namnet ovanför
sig (alla har det när du står nära). Dropp låter olika per rarity, och episka och legendariska
annonseras. När du plockar upp vapnet ringer en ring i rarity-färgen, och upptäcktsrutan får
rarity-band, ljusstrålar och (episk+) konfetti. I inventoryt har platserna rarity-kant; episka
lyser och legendariska glimmar.

## Samla och bygga

1. Bygg en **Forge** i lägret och smid en **hacka** (Forge → Tools). Det finns tre nivåer; högre
   nivå hugger snabbare och kan bryta kristaller.
2. Gå fram till ett träd eller en sten och tryck Use (håll inne för att fortsätta). Träd ger
   **trä** och stenar ger **sten**. Utanför lägret växer de tillbaka efter en stund; inne i lägret
   förblir marken röjd så att du kan bygga där.
3. Tryck **G** (eller hammarknappen) i lägret för **byggläget**. Välj något i listan och klicka
   eller tryck på marken. Dra för att bygga en hel rad. Högerklick eller X-verktyget river och ger
   tillbaka halva kostnaden.

| Konstruktion | Gör |
| --- | --- |
| Trävägg / stenvägg | Stoppar fiender och deras skott. Stenväggen håller längre (kräver Hearth 2) |
| Grind | Du går igenom, fiender gör det inte |
| Pilturret / eldturret | Skjuter på fiender inom räckvidd; skadan växer med din nivå och Training Grounds |
| Spikfälla | Skadar fiender som går över den |
| Fackla, banderoll, trägolv, stenväg | För att göra lägret till ditt |

Lägrets byggyta växer med varje Hearth-uppgradering. Fiender som blockeras av en vägg hugger på
den, och turrets som skjuter drar till sig fiender. Skadade konstruktioner lagar sig själva när
lägret är lugnt. Logik: `src/game/construction.js` och `src/game/gathering.js`; grafik:
`src/render/structures.js`; byggpanelen: `src/ui/build.js`.

## Fiender

Fiender ser dig bara inom sitt synfält (6–8 rutor beroende på typ, `sight` i datat). Annars
strövar de runt där de föddes. När en fiende får syn på dig visas ett "!", och flocken runt den
vaknar också. Springer du tillräckligt långt bort ger de upp ("?"). Blir en fiende träffad jagar
den dig även på längre avstånd. Fiender går runt sjöar, träd och väggar i stället för att fastna.
Flygande fiender kan flyga över träd men aldrig över vatten. Loot hamnar alltid på mark du kan gå
på.

## Läger (basen)

Lägret mitt i världen byggs ut med scrap, essence, trä och sten. Gå fram till en byggnad och tryck
Use, eller öppna lägerpanelen (B / hus-knappen). Varje byggnad har nivåer med krav på spelarnivå
(och ibland en besegrad boss), och all data ligger i `gamedata.json` → `base`.

| Byggnad | Gör |
| --- | --- |
| Hearth | Vila och läk, sätter återupplivningspunkt. Uppgraderingar ger mer max-HP |
| Forge | Låser upp crafting. Uppgraderingar ger billigare crafting, högre item level och bättre catalysts |
| Vault | Fler platser i väskan och förrådet |
| Library | Billigare research |
| Training Grounds | Mer Attack Power och Defense |
| Essence Well | Producerar essence i realtid, även när du inte spelar (med tak) |
| Waystone | Teleportera hem till lägret. Nivå 2: gå tillbaka dit du var |

Logiken ligger i `src/game/base.js` (rena funktioner, testade i `tests/unit/base.test.js`),
panelen i `src/ui/base.js` och pixelgrafiken för varje byggnad och nivå i `src/render/buildings.js`.

## Gränssnitt och animationer

- **Pixelgränssnitt:** typsnittet Pixelify Sans (OFL, ligger i `fonts/` så det fungerar offline),
  pixelramar som 9-slice-SVG:er och egna pixelikoner (`src/ui/icons.js`), inga emoji.
- **Inventory:** flikar med antal, sortering (nyast, rarity, styrka, typ), filter (närstrid,
  distans, special, favoriter), märken för utrustat, NEW och favorit, jämförelse stat för stat mot
  vapnet du håller i, och snabbskrotning som aldrig rör favoriter eller det utrustade vapnet.
  Tangentbord: piltangenter väljer, Enter utrustar, T flyttar mellan väska och förråd, F favorit,
  X skrotar, Q/E byter flik.
- **Forge:** fyra steg (typ, material, element, kvalitet) med klickbara rutor i stället för
  rullgardiner, tillval i en egen sektion och en live-förhandsvisning av vapnet på städet. På
  mobil ligger kostnad och Forge-knapp fast längst ned.
- **Vapenanimationer** (`src/render/weapon-anim.js`): varje attack har upptakt, slag och
  efterföljning. Skadan landar på träffögonblicket, svingar växlar sida (kombokänsla), och slag
  ger släpspår, hit-stop och studs på fienden.

## Kravspecifikationen och var den är implementerad

| § | Krav | Implementation |
| --- | --- | --- |
| 1 | Installation, ikon, namn, splash, manifest | `manifest.webmanifest` (standalone, `orientation: any`, ikoner 72–512 + maskable), `icons/` (genereras av `scripts/make-icons.mjs`), splash i `index.html` |
| 1 | Responsivitet | `css/app.css` (safe areas, portrait/landscape, helskärmspaneler på mobil), `src/render/renderer.js` (heltalsskalad lågupplöst buffert för alla skärmar) |
| 1 | Offline | `sw.js` + `precache-manifest.js`, statusindikator (`#net-status`, titelskärm, inställningar) |
| 1 | Prestanda | Lazy-laddade paneler (`src/ui/panels.js`), chunk-förrendering, partikel- och fiendebudgetar, automatisk kvalitetsnivå (`Game#trackPerformance`) |
| 1 | PWA-uppdateringar | `src/pwa/register.js`: "Ny version – Uppdatera nu / Senare", sparar före aktivering |
| 1 | Lagring | `src/storage/db.js`, `src/storage/save.js`, `src/storage/sync.js` |
| 1 | Webbläsarstöd | `src/pwa/support.js`, fallbacks: localStorage/minne, Worker → huvudtråd, ingen SW → vanlig webbapp |
| 2 | Player Controller + stats (ingen stamina) | `src/input/input.js`, `src/game/stats.js`, `src/game/game.js` |
| 3–4 | Procedurella vapen, Weapon DNA, Web Worker | `src/weapons/generator.js`, `src/weapons/dna.js`, `src/weapons/worker.js`, `src/weapons/weapon-service.js` |
| 5 | Archetypes (21 st, nya via data) | `data/v1/gamedata.json` → `archetypes` |
| 6–8 | Stats, modifiers (33), effekter (25) | `gamedata.json`; körs generiskt av `src/game/combat.js` via hooks |
| 9 | Kombinationsregler | `src/weapons/rules.js` (omöjligt, motstridigt, oläsligt, för tungt för mobil, rarity-krav) |
| 10–11 | Rarity och Legendary abilities (10 st + twists) | `rarities`, `abilities`, `abilityTwists`; `src/game/abilities.js` |
| 12 | Procedurell grafik | `src/weapons/visuals.js` (parametrar) → `src/render/weapon-sprite.js` (pixelart) |
| 13 | Namngivning | `src/weapons/naming.js` + `names` i datat |
| 14 | Pipeline | `generateWeapon()` följer stegen 1–10 i ordning |
| 15, 20, 24 | Variation och identitet (builds) | `themes`: varje vapen får en tydlig spelstil ("Fire Build", "Glass Cannon" …) |
| 16 | NEW WEAPON DISCOVERED | `src/ui/discovery.js`, codex i sparfilen |
| 17 | Crafting | `src/weapons/crafting.js`, `src/ui/crafting.js`. Kräver en Forge i lägret |
| 18–19 | Research och bosskärnor | `components` i datat, `src/ui/research.js`, fyra bossar i `src/game/enemies.js` |
| 21 | Balans / Power Budget | Kostnader per modifier/effekt/ability i datat, budget per rarity, taknivåer och en rating-gräns i `finalizeStats` |
| 22 | Vapen som data | All vapenlogik läses från DNA; inget vapen har egen kod |
| 23 | Offline-arkitektur | Allt spelande, genererande, crafting och research sker lokalt; servern används bara för valfri synk |

## Weapon DNA

Ett vapen lagras som ett fullständigt, serialiserbart objekt:

```text
seed, gen (generatorversion), data (dataversion), ctx (generationskontext)
archetype, class, rarity, theme/identity, material, element
attack (mönster + parametrar), base, stats, playerBonuses
modifiers[] / effects[] / drawback / ability   (med färdigupplösta hooks)
power { used, budget }, visual { template, dims, palette, edge, glow, particles, … }
sound { type, wave, pitch, … }, name { text, format, words }
```

- Pipelinens steg drar slumptal från **egna delströmmar** (`deriveSeed(seed, 'modifiers')` osv.),
  så nytt innehåll i ett steg inte ändrar resultatet i de andra.
- Generatorn använder bara heltalsoperationer och exakt IEEE-aritmetik (inga
  `Math.sin/pow/exp/random`), så resultatet blir bitidentiskt i alla JS-motorer. Ett test skannar
  källkoden efter förbjudna funktioner, och golden-tester låser fingeravtrycket.
- `seed + ctx + gen + data` räcker för att återskapa vapnet. Vapenkoder (`PGW1.…`) kan delas och
  förhandsvisas på andra enheter (Inventory → Codex).
- Hela DNA:t sparas, så redan hittade vapen ändras aldrig när speldatat uppdateras.
  Ändras generatorns algoritm så att gamla seeds ger andra vapen ska `GENERATOR_VERSION` höjas.

**Power Budget:** varje modifier kostar `base + per × värde` (t.ex. +10 % Attack Speed = 5,
Fire Damage 20 % = 8, Chain ×3 = 20, Lifesteal 7 % = 15), effekter och abilities har egna
kostnader och nackdelar (t.ex. *Fragile*) ger tillbaka budget. När budgeten är trång prioriteras
rarityns minsta antal modifiers, sedan beteendeförändrande modifiers, obligatoriska effekter,
planerad ability och sist valfria extra.

## Speldata och innehållsuppdateringar

Allt innehåll finns i `data/v1/gamedata.json` (`schemaVersion` + `dataVersion`). Klienten deklarerar
i `src/data/capabilities.js` vilka primitiv den kan köra (attackmönster, sprite-mallar,
hook-actions, abilities). Därmed gäller:

- **Nya archetypes, modifiers, effekter och abilities** som använder befintliga primitiv kan
  levereras genom att bara byta JSON-filen, utan ny klient. Service Workern hämtar datat med
  *stale-while-revalidate* och meddelar spelaren att nytt innehåll laddats ner.
- Poster som kräver okända primitiv hoppas över, så en äldre klient degraderar kontrollerat.
- Inkompatibla ändringar får en ny URL (`data/v2/…`), så gamla klienter aldrig får data de inte
  kan läsa.

## PWA: cache och uppdateringar

| Resurs | Strategi | Cache |
| --- | --- | --- |
| HTML, CSS, JS, ikoner | Precache, cache-first | `pixelgame-shell-<innehållshash>` |
| Speldata | Stale-while-revalidate | `pixelgame-data-v1` |
| Övrigt (same-origin) | Network-first med cache-fallback | `pixelgame-runtime-v1` |
| Sparfiler | Aldrig i Cache Storage, bara IndexedDB | – |

1. `npm run build` räknar ut en hash av alla appfiler och skriver `precache-manifest.js`.
   Varje ändring ger alltså en ny Service Worker.
2. Den nya versionen laddas ner i bakgrunden (kontroll vid start, var 30:e minut, när appen
   visas igen och när nätet kommer tillbaka) och **väntar**.
3. Spelaren ser *"A new version is ready"* och väljer **Update now** (spelet sparas, den nya
   versionen aktiveras, sidan laddas om) eller **Later** (fortsätt spela; versionen installeras
   automatiskt nästa gång appen startas, så ingen fastnar på en gammal version).
4. Vid aktivering raderas bara gamla `pixelgame-shell-*`-cachar. Under en bossfight frågar spelet
   först, eftersom fighten startar om.

## Lagring och sparfiler

- `openStorage()` väljer IndexedDB, sedan localStorage, sedan minne, och begär
  `navigator.storage.persist()`.
- Sparfilen innehåller progression, inventory/storage (fullständigt DNA), codex (upptäckta
  vapen, kända modifiers, upplåsta abilities), crafting-resurser, komponenter och research,
  inställningar, bossar, världsstatus och kvarvarande ability-cooldowns.
- `SAVE_SCHEMA` + `MIGRATIONS` i `src/storage/save.js`. Före en migrering sparas en backup.
  En sparfil från en **nyare** version skrivs aldrig över (spelet kör då skrivskyddat och ber om
  uppdatering). Endast en flik i taget får skriva (Web Locks).
- Autosparning var 15:e sekund, samt när appen döljs, fryses eller stängs och före uppdatering.
  Cooldowns räknas i speltid och sparas, så en PWA som återupptas från bakgrunden varken hoppar
  över eller nollställer dem.
- Export/import: *Settings & Save → Export/Import save file* (JSON med checksumma och
  validering).
- Molnsynk (valfritt): sätt `syncEndpoint` i `src/config.js` (eller `window.PIXELGAME_CONFIG`).
  Klienten gör `PUT {endpoint}/saves/{accountId}` med `{ rev, updatedAt, save }` när enheten är
  online, köar offline (plus Background Sync där det stöds) och hanterar `409` som konflikt.
  Någon server ingår inte i det här repot.

## Projektstruktur

```text
index.html, manifest.webmanifest, sw.js, precache-manifest.js (genererad)
css/app.css
fonts/                        Pixelify Sans (OFL)
data/v1/gamedata.json         allt spelinnehåll
icons/                        genererade ikoner
src/
  main.js, config.js          uppstart, livscykel, PWA-kopplingar
  core/                       deterministisk RNG, matematik
  data/                       laddning, validering, klientens kapabiliteter
  weapons/                    generator, regler, namn, visuals, DNA, crafting, worker
  game/                       värld, fiender/bossar, strid, abilities, loot, status, fx, läger,
                              insamling (gathering.js), byggen (construction.js)
  render/                     renderer, pixelsprites, tiles, vapensprites, byggnader,
                              konstruktioner, animationer
  input/, audio/, storage/, pwa/, ui/
scripts/                      dev-server, precache-byggare, ikongenerator
tests/unit/, tests/e2e/
```

## Driftsättning

Hosta repots rotkatalog som statiska filer över **HTTPS** (Service Workers kräver det; `localhost`
fungerar lokalt). Alla sökvägar är relativa, så appen fungerar även i en underkatalog (t.ex.
GitHub Pages). Kör `npm run build` före varje deploy. `sw.js` registreras med
`updateViaCache: 'none'`, så långa cache-headers på servern stoppar inte uppdateringar.

## Kända begränsningar och nästa steg

- Ingen backend ingår. Synk-klienten och protokollet finns, men en server och
  kontohantering behöver byggas separat.
- Ljud och grafik genereras procedurellt (ingen musik ännu).
- Fiender attackerar inte lägret på egen hand ännu. Ett naturligt nästa steg är räder mot
  lägret (vågor av fiender) där väggar och turrets verkligen sätts på prov.
- iOS saknar manifest-splash. Där används appens egen startskärm.
