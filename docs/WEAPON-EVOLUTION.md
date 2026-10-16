# Weapon Evolution: hitta ett vapen och gör det till ditt eget

Målet: spelaren ska inte byta vapen hela tiden. Man hittar ett **grundvapen**, investerar i det och
förvandlar det steg för steg till sitt drömvapen genom val, utforskning, bossar och sällsynta
material.

Systemet bygger på det som redan finns: Weapon DNA (`src/weapons/`), verkstadens verktyg för att
ändra ett vapen (`src/weapons/workshop.js`: `changeArchetype`, `makeModifier`, `makeEffect`,
`makeAbility`, `recomputeStats`, `newLook`), komponenter och forskning, bossarnas kärnor,
legendariska krafter (`src/weapons/legendary.js`, `dna.signature`), smedjan och Codex. Inget
parallellt vapensystem byggs.

## 1. Grundvapen

Sex vapenfamiljer. Varje familj har ett grundvapen som går att hitta, och de övriga vapentyperna i
speldatan är **utvecklade former** som bara nås genom trädet:

| Familj | Grundvapen | Utvecklade former |
|---|---|---|
| Svärd | sword | greatsword (Titan), dagger (Skugga), scythe (Skördare) |
| Yxa | axe | hammer (Jordskalv), mace (Krossare), axe (Bärsärk) |
| Spjut | spear | spear (Lans), whip (Piska) |
| Båge | bow | crossbow (Armborst), bow (Långbåge), gun → cannon (Bössa) |
| Trollstav | wand | staff (Ärkemagiker), orb (Glob), lantern (Lykta) |
| Kastvapen | throwing | chakram, boomerang, warfan |

Grundvapen hittas genom utforskning: kistor, ruiner, begravda skatter, bossar, marknader och
smedjan. **Vanliga fiender tappar inte längre vapen**. Eliter gör det i 5 % av fallen och kistor i
8 % (ruiner och skatter oftare; `WEAPON_DROP_CHANCE` i `src/game/economy.js`). Allt som hittas,
köps eller smids är högst *sällsynt* (rare) och ett grundvapen (generatorns `baseOnly`, som sparas
som `ctx.base` i DNA:t). Episkt och legendariskt blir ett vapen bara genom att utvecklas. Bossar ger
ett grundvapen, gärna av en familj du inte har än (`missingBase`), och sin kärna, som behövs i
trädet. Smedjan har bara Azure Catalyst kvar (alltid sällsynt), och abilities smids inte.

## 2. Trädet

Alla familjer har samma form. Grenarna och kraven är däremot familjens egna (data:
`evolution` i `data/v1/gamedata.json`):

| Nivå | Steg | Val | Krav (utöver skrot och essens) |
|---|---|---|---|
| 0 | Grundvapen | – | hittas |
| 1 | Härdat | – | Smedja 1 |
| 2 | **Form** | 2–3 grenar: ny vapentyp och spelstil | Smedja 2, en komponent från ett visst biom |
| 3 | Mästarverk | grenens egen | Smedja 3, ytterligare en komponent, minst en besegrad boss |
| 4 | **Ingjutning** | element: 4 val per familj | Smedja 4, en bosskärna |
| 5 | **Uppvaknande** | 2–3 legendariska krafter | Smedja 5, en kärna från fjärrländerna, Star Shards och fjärrmaterial |

Varje steg höjer sällsyntheten: härdat minst ovanlig, form sällsynt, ingjutning episk och
uppvaknande legendarisk. Varje steg ger också fler modifierare och effekter och mer skada. Valen är
låsta: en gren utesluter de andra, så vapnet får en tydlig identitet.

**Kraft.** Generatorns kraftak (rating ceiling) per sällsynthet bromsar staplade modifierare, och
ett utvecklat vapen når det taket. Sällsyntheten höjer taket i varje steg, och Mästarverket höjer
det dessutom med 5 % (`evo.mult.ceiling`). På samma nivå slår ett utvecklat vapen ett hittat
sällsynt vapen med ungefär 30 % (Form), 37 % (Mästarverk), 45 % (Ingjutning) och 60 %
(Uppvaknande). Ett uppvaknat vapen är cirka 1,5 gånger ett gammalt legendariskt, och till det kommer
effekterna och den legendariska kraften.

**Nivå och härdning.** Vapnets nivå (`ctx.lvl`) bestämmer grundskadan. Varje steg i trädet har ett
nivåtak (`levelCap`). Med *Härda* höjer du vapnet till din egen nivå, upp till taket, för essens och
skrot. Att utvecklas höjer taket. Grind räcker alltså för att hålla vapnet i takt inom ett steg,
men för att komma högre krävs utforskning och bossar.

## 3. Material och utforskning

Kraven är komponenter som hittas i ett visst biom (biomernas `components`), bosskärnor
(`bosses[].drop.component`), fjärrländernas kärnor och material (prismite, spores, aether) och Star
Shards. Komponenter förbrukas inte: att ha *hittat* den räcker. Det driver utforskning i stället för
grind. Skrot, essens, sten och trä förbrukas.

## 4. Utseende

Vapnet byter utseende när det utvecklas. Det mesta kommer av sig självt, eftersom bilden räknas fram
ur DNA:t (`generateVisual`): en ny vapentyp ger en ny form, ett nytt material ger nya färger,
element ger färgton, glöd och partiklar, och sällsyntheten ger ädelsten, glöd och runor. Från
Mästarverket ritas vapnet i sin typs fulla storlek med alla detaljer typen har (en blodränna, ett
dubbelblad, en tofs …). Trädet sätter också `visual.evo` (nivå och gren), och ritaren
(`src/render/weapon-sprite.js`) lägger då till poleringsglans (1), gravyr (3), en aura av lösa
glödpunkter (4) och runor med en ljusare strålkrans (5). Cacherna för sprites, ikoner och
kompilerade vapen använder `dnaKey` (id + `evo.rev`), så bilden byts direkt.

Svaga designer har gjorts om: gun (en flintlåspistol med lås, avfyrare och bakåtsvept kolv), cannon
(utsvängd mynning, svällande bakstycke, tappar och band), orb (en glaskula med ljus och mörk sida,
virvel och klofattning) och whip (en flätad snärt i vågor). Lång stav klipps inte längre av upptill.

## 5. Gränssnitt

Panelen **Vapenträd** (`src/ui/evolution.js`) öppnas från vapnet i väskan (*Evolve*), från
smedjans flik och med tangenten U (i byggläget väljer U fortfarande Uppgradera). Den visar nivåerna som kolumner (rader på telefon). Varje nod
har en förhandsbild av hur vapnet blir och ett av följande tillstånd:

- **Upplåst**: guldram.
- **Tillgänglig**: kostnader och en *Evolve*-knapp.
- **Låst**: krav med ✓ och ✗.
- **Dold**: en komponent du inte har hittat, i ett steg längre fram, visas som "An unknown find"
  med var du ska leta. Uppvaknandet är dolt tills vapnet har fått ett element.

Grenar du inte valt syns nedtonade, så att du kan planera.

## 6. Data och kod

- `data/v1/gamedata.json` → `evolution`: `families` (grundvapen och grenar), `tiers` (kostnader,
  tak, smedjenivå), `infusions` (element → bosskärna) och `awakenings` (legendarisk kraft → kärna
  och material). En ny gren eller familj är bara data.
- `src/weapons/evolution.js` är gemensam för singleplayer och servern:
  - `familyOf`, `evoOf` (även för vapen från före trädet), `treeFor`, `nodeStatus`,
    `requirementsOf` och `evolveBlockers`
  - `applyNode` (ren funktion: DNA in, nytt DNA ut), `previewNode` och `evoSummary`
  - `temperInfo`, `temperCost` och `temper`
- Singleplayer: `Game.evolve(id, node)` och `Game.temper(id)` betalar, byter DNA i väskan och
  kompilerar om vapnet om det är utrustat.
- Multiplayer: `{t:'evolve', id, node}` och `{t:'temper', id}` i `server/commands.js`. Servern
  kontrollerar allt med samma `evolveBlockers` (virtuellt sparobjekt), sparar DNA:t med
  `game-db.updateItemDna` och skickar `{t:'inv~', dna}`.
- Sparning: allt ligger i DNA:t (`dna.evo`: familj, steg, vägen, `rev`, kraftfaktorer och
  namnets ursprung). Inget nytt sparschema behövs, eftersom tillägget är bakåtkompatibelt. Codex
  får `evolutions` (uppnådda steg, "familj:nod"). Vapenkoder för utvecklade vapen bär hela DNA:t.
- Tester: `tests/unit/evolution.test.js` (alla vägar i alla träd ger giltiga vapen),
  `tests/mp/evolution.test.js` (servern) och `tests/e2e/evolution.spec.js` (panelen).
