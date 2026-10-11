# Territorier och fraktioner: utvecklingsplan och design

Den stora uppdateringen byggs i faser, i den ordning planen anger. Varje fas testas och
publiceras innan nästa bygger vidare på den. Allt fungerar i både singleplayer och
multiplayer. Nyhetsrutan i spelet (`src/ui/news.js`) visar vad som är ute och vad som är
på väg.

| Fas | Innehåll | Status |
|---|---|---|
| 1 | Teknisk genomgång, datamodeller (det här dokumentet) | klar |
| 2 | Ny grafik och Prism Barrens | klar |
| 3 | Mireglass Fen och Skyreach (hästhopp mellan öar) | klar |
| 4 | Sällsyntare ritningar, de bästa bara från svåra bossar | klar |
| 5 | Soldater, trupper, strategikartan och territorier | klar |
| 6 | NPC-fraktioner med baser och strategisk AI | klar |
| 7 | Integration, gamla sparfiler, prestanda och dokumentation | planerad |

Före planen kom också: fuskskydd (inget `window.__pixelgame` på den publicerade sidan),
fler hästflockar som syns på kartan, och dyrare byggen och underhåll.

## 1. Vad som redan finns och återanvänds

| System | Filer | Hur planen bygger på det |
|---|---|---|
| Världen | `src/game/world.js` | Biomer väljs av brus i `biomeAt`. Nya biomer läggs till som *fjärrländer* (se 2.1). Chunkar genereras deterministiskt av fröet, likadant hos klient och server. |
| Rutor och grafik | `src/render/tiles-art.js`, `src/render/renderer.js` | En chunk (16×16 rutor) ritas en gång till en canvas och blittas sedan. Den nya grafiken görs där, så den kostar inget per bildruta. |
| Rörelse | `src/net/movement.js` (`stepMove`, `slideMove`) | Delas av singleplayer, klientens förutsägelse och servern. Hästhopp över klyftor läggs här, så alla räknar likadant. |
| Kollision | `World#blockedFor`, `World#isFree` | Lägen per rörelsetyp (`player`, `horse`, `boat`, `fly`, `pal` …). Nya rutor får en tydlig regel per läge. Dekor påverkar aldrig kollisionen. |
| Fiender och bossar | `src/game/enemies.js` (SP), `server/enemies.js`, `server/bosses.js` (MP), data i `gamedata.json` | Beteenden och bossmönster är namngivna funktioner som data pekar på. Nya fiender återanvänder beteenden. De nya bossarna får några nya mönster, skrivna för både SP och MP. |
| Utseende för varelser | `src/render/creatures.js` | Pixelkartor i strängar. Nya varelser ritas på samma sätt. |
| Komponenter och ritningar | `components` i data, `src/game/loot.js`, `server/loot.js`, `src/weapons/crafting.js` | Ritningar (`type: "blueprint"`) lär smedjan vapentyper. Fas 4 samlar alla källor i en tabell. |
| Arbetare | `src/game/workers.js` (delad), `src/game/workforce.js` (SP), `server/workers.js` (MP), `src/game/pathfind.js` | Soldaterna är arbetare med en annan roll: samma register, samma stuga och samma vägsökning. |
| Lägrets byggnader | `base.buildings` i data, `src/game/base.js` | Training Grounds tränar soldater. Workers' Lodge rymmer dem. |
| Underhåll | `src/game/upkeep.js` (delad) | Soldaternas löner och utposternas underhåll räknas som en egen rad. |
| Byar | `src/game/villages.js` | Fraktionernas baser byggs av block på samma sätt som byarna. Murar, portar och torn är vanliga byggen. |
| Sparning | `src/storage/save.js` (`SAVE_SCHEMA`, `MIGRATIONS`), `server/game-db.js` | Nya fält får standardvärden i `fillDefaults`. Världsversionen lagras i sparfilen (SP) och i `meta` (MP). |
| Multiplayer | `server/*`, `src/net/protocol.js`, `src/mp/*` | Servern bestämmer allt. Nya entiteter skickas i ögonblicksbilderna, nya förfrågningar kontrolleras i `server/commands.js`. |

## 2. Designbeslut

### 2.1 Fjärrländer: tre nya biomer utan att rubba gamla världar

- De tre biomerna läggs **sist** i `biomes`. Biomindex sparas per ruta i chunken, så de
  gamla indexen ändras inte.
- De finns bara **långt ut** (mer än cirka 280 rutor från lägret), i regioner som ett eget
  lågfrekvent brus väljer ut. Vilken av de tre det blir följer klimatet: Mireglass Fen där
  det är fuktigt, Prism Barrens där det är varmt och torrt, Skyreach på kalla höjder.
- **Världsversion.** En världs `gen` är 1 (före uppdateringen) eller 2. Gamla världar
  uppgraderas till 2, men:
  - **Singleplayer:** chunkar du redan har utforskat behåller sin gamla biom (de första
    `legacyExplored` posterna i `save.world.explored`). Där du har varit ser det ut som
    förut.
  - **Multiplayer:** servern sparar vid uppgraderingen en lista över chunkarna runt varje
    klans mark (`meta.legacyChunks`) och skickar den till klienterna. Ingen bas hamnar
    plötsligt i ett träsk eller över ett molnhav.
- De nya bossarna får **inga** stora altare. De dyker upp vid mindre altare i sin egen biom.
  Då flyttas inga befintliga arenor.

### 2.2 Grafiken

- Allt görs i renderingslagret. Koordinater, rutstorlek (16 px), kollision och regler är
  oförändrade.
- Chunkarna förrenderas som förut. Den nya stilen lägger till rikare marktexturer med
  stora ljusa och mörka fläckar, skuggor runt träd och stenar (mörkare skogsbotten),
  strandkanter mot vatten, större trädkronor med kontur, ljus och skugga som når in i rutan
  ovanför, och slagskuggor. Per bildruta tillkommer bara en svag ton och en vinjett från en
  cachad gradient.
- **Inställning:** *Grafik: Rik / Klassisk* (`settings.graphics`). Klassisk ger den gamla
  stilen, om något ser fel ut eller på mycket svaga enheter.
- Dekor (tuvor, löv, rötter) ritas bara i marklagret och påverkar aldrig kollisionen.

### 2.3 Ritningar (fas 4)

- En gemensam tabell `blueprintLoot` i data: per källa (vanlig kista, farlig ruin, fiende,
  elitfiende, boss, svår boss) chansen att få en ritning och fördelningen över nivåerna
  common, rare, epic och legendary.
- **Legendary** finns bara i tabellerna för de svåraste bossarna (de stora altarens bossar
  och de nya biombossarna). Kistor, vanliga fiender och handlare har ingen chans alls.
- Första segern över varje boss ger en bestämd belöning (`firstKill`).
- Dubbletter blir essens och skrot efter nivå.
- Byggnadsritningar (Healing Garden, Prism Relay, Wind Beacon med flera) använder samma
  tabell.

### 2.4 Soldater och trupper (fas 5)

- Roller: `wood` och `stone` (arbetare) samt `guard` (vakt), `infantry`, `archer`
  (distans), `rider` (kavalleri och spaning) och `engineer` (lagar murar).
- Rollbyte kräver **träning vid Training Grounds**. Den tar tid, kostar resurser och kräver
  en viss nivå på byggnaden för varje roll. En soldat hugger inga träd.
- Soldaterna har **utrustning** (nivå 1–5, köps i lägrets panel) och blir starkare med
  erfarenhet.
- **Trupper** (`squads`): namngivna grupper med en order (flytta, försvara, anfalla,
  patrullera, följa, hålla, retirera) och en hållning (defensiv, balanserad, aggressiv,
  patrull, retirera vid förluster).
- Samma kod som arbetarna (`src/game/workers.js`) med en ny modul för strid och order,
  `src/game/soldiers.js`, som både SP och servern använder.

### 2.5 Territorier (fas 5)

- **Utposter** står på bestämda, torra platser ute i världen: en liten skans med flagga,
  palissad och port. Ett **territorium** är marken runt en utpost: inom ungefär 46 rutor
  från flaggan och närmare den än någon annan utpost (lägret har sitt eget). På kartan är
  territorierna alltså områden på den riktiga kartan, inga rutor.
- För att hitta utposterna snabbt delas världen internt i celler (96×96 rutor, centrerade
  på lägret) med högst en utpost var. Cellen ger territoriets nyckel (`'tx,ty'`).
- Ägare: ingen (neutral), spelaren (SP), en klan (MP) eller en fraktion.
- **Erövring:** besegra försvararna och håll flaggan tills mätaren är full, utan fiender i
  närheten. Att bara klicka på kartan räcker inte.
- Ett territorium ger en inkomst varje timme till valvet, rätt att bygga vid utposten och
  plats för en garnison.
- En lång front är svårare att försvara. Varje gränsterritorium sänker garnisonernas
  försvarsbonus lite. Förlorade territorier kan tas tillbaka.

### 2.6 NPC-fraktioner (fas 6)

- Tre till fem fraktioner per värld. Var och en har ett högkvarter i ett eget territorium,
  en **personlighet** (försvarare, expansionist, plundrare eller strateg) och en
  **AI-kvalitet**.
- Baserna har tre nivåer: **läger** (palissad), **fäste** (två torn) och **högkvarter**
  (stenvallar och fyra torn). Tornen skjuter på den som kommer nära. Varje bas har en
  garnison av fraktionens egna trupper (krigare, bågskyttar och en kapten i fästen och
  högkvarter), i fraktionens färg.
- **Strategisk AI** körs med fasta intervall (inte varje bildruta). Den bedömer hot, väljer
  mål (försvara, expandera, plundra, anfalla), samlar trupper, skickar dem längs
  territoriernas grannskap och omvärderar efteråt.
- **Två nivåer av simulering:** nära en spelare strider soldaterna på riktigt i världen,
  och en fraktions armé som kommer inom ungefär 56 rutor kliver ut i världen och
  marscherar på riktigt mot sitt mål (den går att stoppa på vägen). Långt bort marscherar
  arméerna som en helhet och striderna avgörs abstrakt, med samma styrkevärden (hälsa,
  skada, befästningar). Resultaten blir därför jämförbara.
- **Spärrar:** gränser för hur många territorier en fraktion kan ha, hur långt den når och
  hur mycket den kan bygga upp. När spelaren är borta simuleras högst några timmar, och
  fraktionerna kan inte ta spelarens läger.

### 2.7 Strategikartan (fas 5–6)

- En egen panel (tangent **N**, och en knapp i menyn) med **den riktiga kartan** (det
  man har utforskat, ritat som världskartan) och territorierna som områden på den: ägare i
  färg, gränser, utposter och baser, era soldater där de är, trupperna och kända
  fiendearméer på marsch, och status (ert, neutralt, tas just nu, under attack).
- Kartan är till för överblick och order: dra för att panorera, zooma med hjul eller två
  fingrar. Välj en trupp och peka på kartan: anfall, försvara eller patrullera en utpost,
  eller flytta dit. Striderna sker ute i världen, där man ser dem. Panelen visar vad
  gruppen gör och varför den inte kan lyda.

### 2.8 Multiplayer

- Servern bestämmer över territorier, fraktioner, soldater och strider. Klanerna äger
  territorier och trupper.
- Order skickas som förfrågningar (`army`) som servern kontrollerar: ägarskap, räckvidd,
  kostnad och tak.
- Ägarbyten skickas till alla som korta meddelanden. Soldaterna skickas som entiteter i
  ögonblicksbilderna, som arbetarna.
- Varje territorium har en enda tillståndsmaskin på servern, så två klaner kan inte ta
  samma territorium samtidigt.

### 2.9 Prestanda

- Strategisk AI: var 5:e till 10:e sekund. Abstrakta strider mellan territorier kostar
  nästan inget.
- Riktiga soldatentiteter bara nära spelare, med tak per fraktion och per område.
- Vägsökningen (A*) har sökgränser, och vägar planeras bara när målet ändras.
- Grafiken är förrenderad per chunk.

## 3. Datamodeller

### Singleplayer (`save`)

```js
save.world.gen = 2;                    // världsversion
save.base.workers = [{ id, role, gear, rank, xp, trainingTo, trainUntil }]; // soldater har en soldatroll
save.army = {
  squads: [{ id, name, members: [workerId], order: { kind, key?, x, y }, stance }],
  nextSquad: 1,
};
save.territories = {
  owned: { 'tx,ty': { since } }, capture: { 'tx,ty': 0..1 }, cleared: { 'tx,ty': until },
  incomeAt, raidT,
};
save.factions = {
  list: [{ id, name, sv, color, personality, quality, hq: 'tx,ty', bank, alive, hqLost }],
  owned: { 'tx,ty': { faction, tier: 'camp'|'stronghold'|'hq', garrison, since } },
  armies: [{ id, faction, kind, from, to, troops, x, y }], nextArmy, aiT, lastAt,
};
```

### Multiplayer (servern)

- `meta 'territories'`: klanernas territorier `[[key, { owner, since, cleared }]]`.
- `meta 'factions'`: fraktionernas tillstånd (som `save.factions`).
- Klanens soldater ligger i `clan.base.workers` (samma register som arbetarna) och
  trupperna i `clan.base.army`.
- `{ t: 'terr', list, factions, armies }` till alla: vem som håller vad (en fraktions mark
  har ägaren `'f:<id>'` och basens nivå), fraktionerna och deras arméer.

### Territorium (delat, deterministiskt)

```js
outpostFor(world, data, tx, ty) → { key: 'tx,ty', tx, ty, fx, fy, x, y /* flaggan */, tier, biome } | null
regionAt(world, data, x, y)     → utposten (eller lägret) vars mark rutan ligger på, eller null
regionOutline(world, data, site) → gränsen som en polygon av världspunkter
```

### Fraktion

```js
{ id, name, sv, color, personality: 'defender'|'expansionist'|'raider'|'strategist', quality: 1..3,
  hq: 'tx,ty', bank, alive }
// Baserna står i state.owned: { 'tx,ty': { faction, tier: 'camp'|'stronghold'|'hq', garrison } }
```
