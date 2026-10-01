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
| Byt plats: huvudvapen / sekundärt / hacka | Hotbaren ovanför knapparna | 1 / 2 / 3 eller mushjulet | RB |
| Lägg undan (tomma händer) | Tryck på platsen du redan håller | Samma siffra igen | – |
| Segla ut / gå i land | Handknappen vid vattnet / nära land | E | A |
| Inventory / Karta / Meny | Knapparna uppe till höger | I / M / Esc | Y / Start |
| Forge / Research / Läger | I menyn (på datorn även knappar uppe till höger) | C / R / B | – |
| Pals | I menyn, eller tryck på pal-chippen under hälsan | H | – |
| Byggläge (i lägret) | Hammarknappen; tryck på en ruta för att välja den, tryck igen (eller på hammaren) för att bygga, dra från den valda rutan för en mur | G (1–9 väljer, X river, Esc klar) | – |
| Hugga / bryta | Byt till hackan (3), sedan svärdknappen nära träd/sten | 3, sedan Space / E (håll inne) | A |
| Handla på en marknad | Handknappen nära en handlare | E | A |

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
- **Vapen är sällsynta fynd:** 1,8 % av vanliga fiender, 15 % av elitfiender och 25 % av kistorna
  släpper ett vapen. Bossar ger alltid ett (och ibland ett till).
- **Kistor** ger mest essence och scrap (plus lite guld); bara var fjärde har ett vapen.
- **Episka vapen** kommer från ett eget litet slag, precis som legendariska: 1,2 % av vapnen från
  vanliga fiender, 4 % från elitfiender, 3 % från kistor och 30 % från bossar. Allt annat är
  vanligt till sällsynt (rare).
- **Loot odds** i pausmenyn visar exakt chans för varje rarity, per källa (fiende, elitfiende,
  kista, boss och varje catalyst i Forge), för din nivå och luck just nu. Tabellen räknas fram
  med samma siffror som spelet slår med (`rarityOdds` i `src/game/economy.js`).
- **Skrotning** ger lite: från 2 scrap för ett vanligt vapen till 24 scrap och 12 essence för ett
  legendariskt.
- **Crafting** kostar mer och blir dyrare med din nivå (+6 % per nivå); Forge-nivåer ger rabatt.
  Priset byggs upp av dina val: bättre material, element-kärnor och runor kostar mer (se Forge
  nedan).
- **Catalysts:** Azure kräver Forge 2 och Violet (garanterat episkt, 600 essence och 300 scrap)
  Forge 4. Golden (legendariskt) kräver Forge 5,
  en besegrad boss, 2 500 essence, 1 200 scrap och **3 Star Shards**, så det tar lång tid.
- **Guld** är marknadernas valuta. Det mesta kommer från att sälja vapen; bossar och ibland
  elitfiender och kistor ger lite.
- **Star Shards** är sällsynta. En boss ger en första gången du besegrar den, sedan 25 %
  chans. Du får också en när du skrotar ett legendariskt vapen, och ibland säljer en
  marknad en för 4 000 guld.
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

## Legendariska vapen: som att öppna ett case

Legendariska vapen ska kännas som att få en kniv i ett CS:GO-case: extremt sällsynta och värda
mycket.

- Vanlig loot stannar på **rare**. Ett legendariskt vapen kräver ett eget, litet slag
  (`src/game/economy.js`, seedat per sparfil): ungefär 0,15 % per vanligt vapendropp, 0,5 % från
  elitfiender, 0,4 % från kistor och 3 % från bossar. Luck höjer chansen lite.
- **Kistor och Forge öppnas som ett case:** en remsa med vapen rullar förbi en markör och
  saktar in. Legendariska syns bara som en gyllene ★ tills remsan stannar. Resultatet är bestämt
  innan rullningen börjar, och *Skip* hoppar direkt till det.
- Varje vapen har ett **värde i guld** som visas på vapenkortet. Ett legendariskt är värt
  tusentals guld (över 20 gånger mer än ett episkt), och upptäcktsrutan visar det direkt.
- Att smida ett legendariskt kräver Golden Catalyst (se ovan).

### Legendariska krafter

Varje legendariskt vapen med en ability får en **legendarisk kraft** i stället för en vanlig
ability. Kraften väljs efter vapnets element och seed (samma vapen får alltid samma kraft), och
den blir starkare och laddar om snabbare ju bättre vapnet rullade sin ability. Kraften ligger som
ett lager ovanpå vapnets DNA, så legendariska vapen du redan har får den också.

| Kraft | Element | Gör |
| --- | --- | --- |
| Starfall | Holy, Arcane | Stjärnor regnar ned över fienderna runt dig och exploderar i ljus |
| Dragon's Breath | Fire | En kon av drakeld som följer ditt sikte och lämnar marken brinnande |
| Absolute Zero | Ice, Wind | En snöstorm runt dig saktar ned allt, fryser det sedan och krossar det |
| Wrath of Storms | Lightning, Wind | Tre vågor av blixtar som hoppar från fiende till fiende |
| Event Horizon | Void | En singularitet drar in fiender och kollapsar i en enorm explosion |
| Thousand Blades | Physical, Bleed | En gloria av spöklika svärd som jagar fiender ett efter ett |
| Venom Bloom | Poison, Earth | En jätteblomma växer upp och pulserar giftvågor i flera sekunder |
| Ascension | Arcane, Holy, Earth, Bleed | Du blir en avatar: mycket starkare och snabbare, och varje slag skickar ut en chockvåg |

När en legendarisk kraft används blinkar skärmen i kraftens färg och namnet syns ovanför dig.
Vapenkortet visar den under *Legendary Power*. Logik: `src/weapons/legendary.js` och
`src/game/abilities.js`; data: `gamedata.json` → `legendaryAbilities`.

## Loadout: tre platser

Du har tre platser: **huvudvapen (1)**, **sekundärt vapen (2)** och **hackan (3)**, som har en
egen reserverad plats. Byt med 1/2/3, mushjulet, RB på handkontrollen eller genom att trycka på
hotbaren (på mobil ligger den ovanför knapparna). Ett nytt vapen kan läggas direkt som
huvudvapen eller sekundärt, och inventoryt markerar vapnen med 1 och 2. Med hackan i handen
hugger attackknappen träd och sten, och den gör lite skada på fiender också.

Tryck på platsen du redan håller (samma siffra eller samma ruta i hotbaren) för att **lägga
undan** den. Då håller du ingenting: attackknappen blir en hand som bara används för att prata,
öppna och plocka upp, så du slår inte någon av misstag (bra på marknader).

## Marknader

Ute i världen finns sällsynta, befästa **marknader** (ungefär en per tio 112×112-rutors
områden, aldrig nära lägret eller en boss). Du får höra rykten om den första i en viss riktning
när du når nivå 4.

- Varje marknad är en egen bas med en av fyra planlösningar: **muromgärdad basar**, **rund
  borg**, **palissadläger** eller **oas**. De har murar, grindar, torn, facklor och stånd, byggda
  i trä eller sten beroende på plats. Monster föds aldrig inne på en marknad.
- **Handlare** står bakom sina stånd (prata med dem över disken med E). De säljer tre vapen
  (vanligen ovanliga eller sällsynta, ibland episka, mycket sällan ett legendariskt till överpris), trä, sten,
  scrap, essence, en komponent och ibland en Star Shard. Sortimentet byts var 20:e minut.
- **Sälj** vapen och material, eller **byt in** ett vapen mot deras. Inbytesvärdet dras av från
  priset. Handlarna köper för 60 % av värdet och säljer för 170 %, så marknader hjälper dig men
  bär dig inte.
- **Skadar du någon** på marknaden vänds deras turrets mot dig i 3 minuter (5 minuter om du
  dödar någon), och ingen handlar med dig så länge. Marknadens turrets skjuter över sina egna
  murar.

Logik: `src/game/markets.js`; placering: `World#marketForCell` i `src/game/world.js`; panelen:
`src/ui/market.js`.

## Karta

Kartan (M eller kartknappen) visar allt du har upptäckt. Världen avslöjas i områden runt dig
medan du går, och det sparas. Dra för att panorera, zooma med hjulet, nyp eller +/−. **Me** och
**Camp** centrerar kartan, och **All** zoomar ut så att allt du har utforskat syns. Kartan kan
zoomas mycket långt ut (tusentals rutor); då ritas varje område som en färg, så det går snabbt
även när du har seglat över halva världen. Hav och öar syns i blått och grönt.

Markeringarna visar **hotspots**: lägret, bossar (bleka tills du har utforskat där, överkryssade
när de är besegrade), marknader du har sett, helgedomar, kistor du inte har öppnat, Waystonens
återvändarpunkt och dina egna **nålar** (tryck på *Pin* och sedan på kartan; tryck på en nål för
att ta bort den). Kod: `src/ui/map.js`.

## Hav, öar och båtar

Världen har nu **stora hav**. Närmast lägret är det alltid fast mark (drygt 170 rutor åt alla
håll, med en naturligt oregelbunden kust), men längre ut breder hav och ö-världar ut sig.

- **Grunt kustvatten** (turkos) och **öppet hav** (mörkblått). Stränderna är sandiga.
- **Öar** (Sunken Isles) med palmer, egna fiender, rikare kistor, **idoler** (+2 max-HP för alltid,
  en gång per idol), **skeppsvrak** och **nedgrävda skatter** som grävs upp med hackan.
- **Flaskpost** flyter i land på stränderna: öppna den så får du en skattkarta, och skatten
  markeras med en nål på kartan.

**Båtar** byggs i Forge → Tools (under hackorna) av trä, sten, scrap och essence. Du bär båten
med dig: gå fram till vattnet och tryck Use för att segla ut, och Use nära land för att gå i land.
Du styr som när du går, kan slåss från båten, och sparar du ute på havet fortsätter du segla när
du laddar spelet.

| Båt | Kostnad | Fart | Kan |
| --- | --- | --- | --- |
| Log Raft | 60 trä, 40 essence (Forge 1) | 3,6 | Sjöar och grunt kustvatten, inte öppet hav |
| Sailing Sloop | 180 trä, 40 sten, 90 scrap, 200 essence (Forge 3) | 5,4 | Allt vatten, även öppet hav |
| War Galleon | 420 trä, 150 sten, 300 scrap, 650 essence (Forge 5 + besegrad boss) | 7,2 | Allt vatten; skrovet tar 40 % av skadan du får till sjöss |

**Havets faror:** ute på havet dyker det upp havsdjur (bara när du seglar, och de kan aldrig gå
upp på land).

| Djur | Var | Hur det slåss |
| --- | --- | --- |
| Haj | Allt havsvatten, även kustvattnet | Cirklar runt båten och gör plötsliga utfall för att bita. Syns som en fena i vattnet |
| Sjöorm | Bara djupt, öppet hav | Slingrar sig runt dig på avstånd och spottar vattenkaskader. Dyker sedan (då går den inte att träffa) och bryter upp ur vattnet nära dig med en markering först. Ger mycket essence, scrap och guld, ibland ett vapen eller en Star Shard |

Fler hajar dyker upp ju längre ut du seglar. En flotte kan bara segla i kustvattnet, så där är det
bara hajar. Galeonens skrov tar en del av skadan. Loot från havsdjur flyter på vattnet, så du kan
plocka upp den från båten.

Kod: `src/game/sailing.js` (båtar, sjösättning, landstigning), `World#seaAt` i
`src/game/world.js` (hav och öar), `src/render/boats.js` (grafik), hajar och sjöormar i
`src/game/enemies.js`.

## Småsaker att hitta

Utspritt i världen finns små saker som inte ändrar spelet mycket, men som gör det roligare att
utforska (`src/game/discoveries.js`):

| Fynd | Var | Vad händer |
| --- | --- | --- |
| Kvarlevor | Överallt | Lite scrap och guld, och en lapp med ett tips eller en liten historia |
| Vägskylt | Överallt | Pekar mot närmaste obesegrade boss eller marknad, med avstånd |
| Glödsvampar | Skog, slätt, snö, Voidreach | Läker lite och ger +25 % fart i 45 sekunder |
| Övergivet läger | Överallt | Vila (full hälsa) och ett litet förråd |
| Flaskpost | Stränder | En skattkarta: skatten nålas fast på kartan |
| Skeppsvrak | Stränder och öar | Trä, scrap och guld |
| Idol | Öar | +2 max-HP, permanent |
| Nedgrävd skatt | Öar | Grävs upp med hackan: som en mycket rik kista, ibland en Star Shard |

Dessutom finns det liv runt omkring dig: fjärilar på ängarna, eldflugor i skogen och fiskar som
hoppar ute på havet.

## Bossar

Det finns **åtta bossar**, en för varje biom, och varje altare kan bara besegras **en gång**.
När bossen är död tystnar altaret, och för att slåss igen måste du hitta ett nytt altare.

- **Stora altare:** varje boss har ett stort altare. De ligger långt ifrån varandra, från cirka
  150 rutor från lägret och sedan ungefär var 120:e ruta längre ut, åt olika håll. De står på
  fastlandet, utom Tide Leviathans som kan hamna på en ö. De syns (bleka) på kartan från början.
- **Mindre altare:** utspridda över hela världen, i ungefär hälften av alla stora rutor
  (200×200), aldrig närmare lägret än 200 rutor. Bossen hör till landet runt altaret (en Sand Wyrm
  i öknen, en Thornmother i skogen, och så vidare). De syns på kartan när du har utforskat dem.
- Kompassen och vägskyltarna pekar mot närmaste altare som fortfarande har en boss. Ju längre ut
  ett altare ligger, desto starkare är bossen.
- Alla bossar har egen grafik och egna attacker, och när du väcker en får du ett tips om hur den
  slåss.

| Boss | Biom | Signatur |
| --- | --- | --- |
| Inferno Titan | Ashlands | Meteorer faller där du står, och laddningen lämnar brinnande mark efter sig |
| Frost Warden | Frostvale | Riddare i isrustning: frostandedräkt i en kon, isspikar i linjer, en isring som sluter sig (hitta luckan) och en kylande aura |
| Storm Colossus | Stormpeaks | Svävande stengolem: blixtnedslag där du står, snabba blixtrusningar, statiska klot som cirklar runt den och en solfjäder av blixtar |
| Void Herald | Voidreach | Gömmer sig bland spegelbilder (auto-aim avslöjar inte vilken som är äkta) och öppnar singulariteter som drar in dig |
| **Bone King** | Green Plains | Väcker skelett ur marken runt dig, kastar solfjädrar av ben och lägger förbannelser som brister en stund senare (blödning) |
| **Thornmother** | Deepwood | Rötter skjuter upp mot dig i linjer, giftmoln fyller luften, och hon gräver ned sig och slår rot på ett nytt ställe |
| **Sand Wyrm** | Sunscar Desert | Dyker ned i sanden och bryter upp under dig (spring från den mullrande cirkeln), skalv som rullar ut i ringar, sandspott |
| **Tide Leviathan** | Sunken Isles | Vattenväggar sveper över ön (hitta luckan), gejsrar under fötterna och virvlar som drar in dig |

De nya bossarna har egna boss-kärnor till Forge (Bone Crown, Heartwood, Wyrm Fang, Tide Pearl).
Bossar släpper alltid ett vapen, minst sällsynt (rare), med 30 % chans till episkt och 3 % till
legendariskt.

## Samla och bygga

1. Bygg en **Forge** i lägret och smid en **hacka** (Forge → Tools). Det finns fem nivåer. Varje
   ny hacka hugger snabbare och kan bryta något nytt:

   | Hacka | Kräver | Bryter också | Extra |
   | --- | --- | --- | --- |
   | Iron | Forge 1 | Träd, sten, kaktus, palmer | – |
   | Steel | Forge 2 | Lila kristaller (Voidreach) | – |
   | Mythril | Forge 3 | **Obsidian** (Ashlands): sten och essence | – |
   | Adamant | Forge 4 | **Järnmalm** (Stormpeaks, öknen, Frostvale): scrap | +25 % material |
   | Starforged | Forge 5 + två olika bossar | **Stjärnsten** (Voidreach): mycket essence, ibland en Star Shard | +50 % material, snabbast sving |
2. Byt till hackan (plats 3), gå fram till ett träd eller en sten och tryck på attack eller Use
   (håll inne för att fortsätta). Träd ger
   **trä** och stenar ger **sten**. Utanför lägret växer de tillbaka efter en stund; inne i lägret
   förblir marken röjd så att du kan bygga där.
3. Tryck **G** (eller hammarknappen) i lägret för **byggläget**. Välj något i listan och klicka
   på marken. Dra för att bygga en hel rad. Högerklick eller X-verktyget river och ger tillbaka
   halva kostnaden.
   **På telefon** är byggpanelen en smal remsa med ikoner högst upp, så lägret syns. Tryck på en
   ruta för att välja den (den pulserar), tryck igen eller på hammarknappen för att bygga, och dra
   från den valda rutan för att bygga en mur. Dra någon annanstans på vänster sida för att gå.

| Konstruktion | Gör |
| --- | --- |
| Trävägg / stenvägg | Stoppar fiender och deras skott. Stenväggen håller längre (kräver Hearth 2) |
| Grind | Du går igenom, fiender gör det inte |
| Pilturret / eldturret | Skjuter på fiender inom räckvidd; skadan växer med din nivå och Training Grounds |
| Spikfälla | Skadar fiender som går över den |
| Fackla, banderoll, trägolv, stenväg | För att göra lägret till ditt |

**Golv** ligger i ett eget lager: torn, murar, facklor och fällor kan stå på ett golv, och ett
golv kan läggas under något som redan står. River du tar verktyget det översta först och golvet
sedan. **Murar sitter ihop** åt alla håll: en mur som byggs lodrätt blir en sammanhängande mur
utan spetsar och kanter mellan rutorna, både i trä och sten.

Lägrets byggyta växer med varje Hearth-uppgradering. Fiender som blockeras av en vägg hugger på
den, och turrets som skjuter drar till sig fiender. Skadade konstruktioner lagar sig själva när
lägret är lugnt. Logik: `src/game/construction.js` och `src/game/gathering.js`; grafik:
`src/render/structures.js`; byggpanelen: `src/ui/build.js`.

## Huvudmeny

Innan du kommer in i världen visas en huvudmeny: **Play** (med en rad om din sparfil: nivå,
antal vapen och speltid), **New world**, **Settings** (samma inställningar som i spelet),
**How to play** och **Multiplayer**. Multiplayer är inte byggt än; knappen visar bara ett
meddelande om att det är under utveckling. Bakom menyn driver världen sakta förbi.

## Fiender

Varje biom har sina egna monster, och alla är animerade: de har gång-, vilo- och attackrutor, och
renderaren lägger till rörelse ovanpå (slimes hoppar och trycks ihop när de landar, flygare
flaxar och guppar, svävare svajar, och den som laddar en attack hukar sig och darrar med ett
blinkande "!" innan den rusar). Grafiken finns i `src/render/creatures.js` och beteendena i
`src/game/enemies.js`.

| Biom | Monster |
| --- | --- |
| Green Plains | Slime, **Tusk Boar** (rusar från långt håll), Bat, Skeleton, Brute |
| Deepwood | Slime, **Thornback Spider** (hoppar på dig från nära håll), Wisp, Bat |
| Sunscar Desert | **Dune Scorpion** (sticket kan förgifta), **Mummy**, Skeleton, Bat |
| Frostvale | **Frost Wolf** (jagar i flock och cirklar in från sidan), **Yeti**, Wisp |
| Ashlands | Slime, **Fire Imp** (flygande eldkastare), Brute |
| Stormpeaks | **Harpy** (dyker), **Stone Golem** (tung laddning), Bat, Skeleton |
| Voidreach | **Void Eye** (svävar och skjuter), **Shade** (bleknar bort och dyker upp bakom dig), Wisp, Bat |
| Sunken Isles | **Reef Crab** (går i sidled och nyper), Slime, Bat |

Elementvarianter färgas i elementets färg men behåller en ton av sin egen, så de går att känna
igen. Hur många som dyker upp tillsammans styrs av `group` (vargar kommer 2–4 åt gången, golems
och yetis ensamma).

Fiender ser dig bara inom sitt synfält (6–8 rutor beroende på typ, `sight` i datat). Annars
strövar de runt där de föddes. När en fiende får syn på dig visas ett "!", och flocken runt den
vaknar också. Springer du tillräckligt långt bort ger de upp ("?"). Blir en fiende träffad jagar
den dig även på längre avstånd. Fiender går runt sjöar, träd och väggar i stället för att fastna.
Flygande fiender kan flyga över träd men aldrig över vatten. Loot hamnar alltid på mark du kan gå
på.

## Pals

En pal är en liten följeslagare som går med dig och antingen slåss vid din sida eller hugger ved
och bryter sten åt dig (och lämnar över det direkt). Den är inte lätt att få:

1. **Hitta ett Pal Egg.** Du får alltid ett första gången du besegrar varje boss. Annars finns
   de ibland i nedgrävda skatter på öar (30 %), hos sjöormar (15 %), när du besegrar en boss igen
   (30 %) och mycket sällan hos elitfiender (0,6 %). Vanliga monster tappar aldrig ägg.
2. **Bygg en Pal Den** i lägret (kräver nivå 6 och en del material).
3. **Värm ägget** i Den (120 essence). Det kläcks efter 90 sekunder, även om du inte spelar.

Det finns tre sorter: **Mossling** (samlare, hugger snabbt, svag i strid), **Emberpup** (kämpe,
biter hårt och bränner) och **Glimmerfox** (allroundare, zappar fiender med blixtar på avstånd).
I pal-panelen (H) väljer du vad den gör: *Fight*, *Gather* eller *Follow*. En samlare försvarar
sig bara om något kommer för nära.

Pals uppgraderas med essence, scrap, trä och sten (dyrare för varje nivå) upp till nivå 10.
Varje nivå ger mer hälsa, skada, insamlingskraft och fart. De kan bryta kristaller från nivå 5,
obsidian från nivå 7 och järnmalm från nivå 9. Pal Den bestämmer taket: varje Den-nivå låter pals växa två nivåer till. Blir din
pal nedslagen tar den en tupplur i 30 sekunder och kommer sedan tillbaka. På havet åker den med i
båten.

Logiken ligger i `src/game/pals.js` (rena funktioner för ägg, kläckning och uppgraderingar, plus
palens beteende i spelet), panelen i `src/ui/pals.js`, datat i `gamedata.json` → `pals` och
testerna i `tests/unit/pals.test.js`.

## Läger (basen)

Lägret ligger på en stor stenlagd plan mitt i världen. Härden står i mitten och de sju andra
byggnaderna i en ring runt den: Essence Well i norr, Forge och Vault snett ovanför, Library och
Training Grounds på sidorna, Pal Den och Waystone längst ned. Den södra sidan är öppen, och en
väg leder ut ur lägret där. Mellan alla byggnader finns gångar. Om något du byggt stod där en
byggnad nu står, tas det ned och du får tillbaka hela kostnaden.

Lägret byggs ut med scrap, essence, trä och sten. Gå fram till en byggnad och tryck
Use, eller öppna lägerpanelen (B / hus-knappen). Varje byggnad har nivåer med krav på spelarnivå
(och ibland en besegrad boss), och all data ligger i `gamedata.json` → `base`.

| Byggnad | Gör |
| --- | --- |
| Hearth | Vila och läk, sätter återupplivningspunkt. Uppgraderingar ger mer max-HP |
| Forge | Låser upp crafting. Uppgraderingar ger billigare crafting, högre item level och bättre catalysts |
| Vault | Fler platser i väskan och förrådet |
| Library | Billigare research |
| Training Grounds | Mer Attack Power och Defense |
| Essence Well | Producerar essence i realtid, även när du inte spelar (med tak). Ger 15 essence/timme per nivå |
| Pal Den | Kläck pal-ägg. Varje nivå låter dina pals växa två nivåer till |
| Waystone | Teleportera hem till lägret. Nivå 2: gå tillbaka dit du var |

Logiken ligger i `src/game/base.js` (rena funktioner, testade i `tests/unit/base.test.js`),
panelen i `src/ui/base.js` och pixelgrafiken för varje byggnad och nivå i `src/render/buildings.js`.

## Gränssnitt och animationer

- **Pixelgränssnitt:** typsnittet Pixelify Sans (OFL, ligger i `fonts/` så det fungerar offline;
  siffran 5 är omritad eftersom originalet var lätt att förväxla med 8 och S),
  pixelramar som 9-slice-SVG:er och egna pixelikoner (`src/ui/icons.js`), inga emoji.
- **Inventory:** flikar med antal, sortering (nyast, rarity, styrka, typ), filter (närstrid,
  distans, special, favoriter), märken för utrustat, NEW och favorit, jämförelse stat för stat mot
  vapnet du håller i, och snabbskrotning som aldrig rör favoriter eller det utrustade vapnet.
  Tangentbord: piltangenter väljer, Enter utrustar, T flyttar mellan väska och förråd, F favorit,
  X skrotar, Q/E byter flik.
- **Forge:** fyra steg (typ, material, element-kärna, catalyst) med klickbara rutor, tillval
  (runa och ability) i en egen sektion och en live-förhandsvisning av vapnet på städet. På mobil
  ligger kostnad och Forge-knapp fast längst ned.
  - Varje rad går **från enkelt till bäst** (vänster till höger), med nivåstreck och priset för
    valet. Ju bättre val, desto dyrare: material i fem nivåer (från Iron, Oak och Bronze till
    Ancient och Dragonscale), element-kärnor i fyra (vanliga element, Blood/Holy, Void/Arcane,
    boss-kärnor) och runor i fem (små bonusar upp till Chain och Execute).
  - Under varje steg förklarar en ruta vad valet gör: vapentypens attackstil och grundvärden,
    materialets bonusar i procent, vad elementet gör med fiender, vad catalysten ger för rarity,
    och runans exakta bonus. Material som inte är framforskade och runor som inte passar vapnet
    visas nedtonade med en förklaring.
  - *Price breakdown* visar var priset kommer ifrån.
- **Helskärm på mobil:** appen installeras med `display: fullscreen`, så systemfälten inte
  ramar in spelet. Canvasen täcker hela skärmen (även bakom notch och rundade hörn, med safe
  areas för gränssnittet). I webbläsaren på en telefon går spelet in i helskärm när du trycker
  Play; det kan stängas av under *Settings → Full screen on phones*.
- **Mobilgränssnitt:** HUD:en är kompakt så att du ser mer av världen: en liten hälsoplatta, en
  smal dock (Inventory, karta, bygg, meny) och en tunn resursrad som lyser upp när något ändras.
  Vapnets namn syns bara en kort stund när du byter. Hotbaren sitter ovanför knapparna, och
  panelerna är kompakta. Samma kompakta HUD används när telefonen hålls på tvären.
- **Notiser på mobil:** små och korta, högst två samtidigt. Viktiga notiser (fynd, bossar, loot)
  går före vanliga, och samma notis igen räknas upp ("+3 wood ×3") i stället för att staplas.
  Notiser flyttar ned till skärmens nederkant när en panel är öppen, så de aldrig täcker
  stängknappen.
- **Hacka utan textrutor:** när du håller hackan får trädet eller stenen du kan hugga bara en
  ram runt sig (röd om hackan är för svag), ingen textruta som skymmer vyn.
- **Pal-chip:** har du en pal med dig visas en liten chip under hälsan med nivå och hälsa (på
  telefon på samma rad som kompassen). Tryck på den för att öppna pal-panelen.
- **Synfält:** *Settings → View* väljer hur mycket av världen du ser (Close, Normal, Wide). Auto,
  som är standard, visar ungefär 30 % mer i bredd på en telefon som hålls upprätt.
- **Vapenanimationer** (`src/render/weapon-anim.js`): varje attack har upptakt, slag och
  efterföljning. Skadan landar på träffögonblicket, svingar växlar sida (kombokänsla), och slag
  ger släpspår, hit-stop och studs på fienden.

## Kravspecifikationen och var den är implementerad

| § | Krav | Implementation |
| --- | --- | --- |
| 1 | Installation, ikon, namn, splash, manifest | `manifest.webmanifest` (fullscreen med standalone som reserv, `orientation: any`, ikoner 72–512 + maskable), `icons/` (genereras av `scripts/make-icons.mjs`), splash i `index.html` |
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
                              insamling (gathering.js), byggen (construction.js),
                              marknader (markets.js), ekonomi och vapenvärde (economy.js),
                              segling (sailing.js), småfynd (discoveries.js), pals (pals.js)
  render/                     renderer, pixelsprites, animerade monster och pals (creatures.js),
                              tiles, vapensprites, byggnader, konstruktioner, båtar, animationer
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
  kontohantering behöver byggas separat. Multiplayer finns bara som en knapp i huvudmenyn än så
  länge.
- Du kan bara ha en pal med dig åt gången, och pals har inga egna förmågor utöver bett, zap och
  insamling. Fler sorter och specialförmågor vore ett naturligt nästa steg.
- Ljud och grafik genereras procedurellt (ingen musik ännu).
- Marknadernas NPC:er är enkla (handlare står still, bybor strövar). Nästa steg kan vara
  karavaner mellan marknader och uppdrag från handlarna.
- Havsdjuren är enkla (hajar och sjöormar). Fler sorter, och boss-sjömonster, vore ett naturligt
  nästa steg.
- Fiender attackerar inte lägret på egen hand ännu. Ett naturligt nästa steg är räder mot
  lägret (vågor av fiender) där väggar och turrets verkligen sätts på prov.
- iOS saknar manifest-splash. Där används appens egen startskärm.
