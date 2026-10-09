# Multiplayer-plan

Plan för multiplayer i Pixelgame: Infinite Arsenal. Spelare möter andra
spelare i PvP, bildar klaner och bygger baser tillsammans. Planen bygger på
de här besluten:

| Fråga | Beslut |
|---|---|
| Världen | Servrar med plats för 20–50 spelare |
| PvP | Fri PvP i vildmarken. Fristaden vid spawn är säker. En bas kan bara raidas när någon i klanen är online, eller under serverns raidfönster |
| Progression | En separat MP-karaktär som bara finns på servern. Singleplayer-sparfilen rörs aldrig |
| Skala och inloggning | Vänner och mindre grupper, cirka 50 samtidigt per server. Konto med e-post, Google eller Discord |

## Status: byggt

Planens faser 0–6 är byggda. Så sätter du upp en egen server:
[MULTIPLAYER-SETUP.md](MULTIPLAYER-SETUP.md).

Hur det körs nu, helt på gratisplaner och utan betalkort:

- **Webbsidan** ligger på Netlify.
- **Den officiella servern** är en Cloudflare Durable Object (`cloud/`) med samma serverkod och
  databasen i objektets SQLite. Klienterna skickar sin styrning 15 gånger per sekund där, så
  att gratisplanens 100 000 förfrågningar per dygn räcker till cirka 37 spelartimmar.
- **Supabase** sköter serverlistan, koderna och inloggning med Discord och Google.
- **Spelare kan köra egna servrar** med `npm run share`: Cloudflare Quick Tunnel, en kod som är
  densamma varje gång, och inloggning med namn och lösenord. Spelarnas Supabase-token skickas
  aldrig till sådana servrar.

En egen Linux-server (Oracle eller annan VPS) fungerar fortfarande om gratisplanen inte räcker.

| Del | Var i koden |
|---|---|
| Delad kärna: protokoll, rörelse, regler | `src/net/` (`protocol.js`, `movement.js`, `rules.js`, `mpbuild.js`, `mpsave.js`) |
| Server: 30 Hz, auktoritativ, SQLite, inloggning | `server/` (`game-server.js`, `players.js`, `combat.js`, `abilities.js`, `bosses.js`, `pals.js`, `discoveries.js`, `markets.js`, `enemies.js`, `loot.js`, `building.js`, `clans.js`, `snapshots.js`, `grid.js`, `net.js`, `auth.js`, `db.js`) |
| Klient: lobby, förutsägelse, interpolering, panelerna | `src/mp/` (`mp-game.js`, `entities.js`, `connection.js`, `lobby.js`, `auth.js`, `panels.js`, `hud-extra.js`) |
| Drift | `cloud/` och `wrangler.jsonc` (Cloudflare), `supabase/` (serverlistan), `scripts/share.mjs` (`npm run share`), `server/Dockerfile`, `docker-compose.yml`, `deploy/` |
| Tester | `tests/mp/` (protokoll, rörelse, regler, inloggning, databas och botar mot en riktig server), `tests/e2e/mp.spec.js` (två webbläsare), `scripts/loadtest.mjs` |

### Uppmätt

- **50 botar** som springer och slåss i vildmarken: servern lägger i snitt
  cirka 7 ms per tick (budgeten är 33 ms) och skickar cirka 10 kB/s per spelare.
  Det som är långt bort uppdateras 10 gånger per sekund i stället för 30.
- **Förutsägelse:** i webbläsartesterna blev det inga stora rättningar av den
  egna rörelsen. Små rättningar förekommer bara vid knuffar från träffar.
- **Fusk:** 300 inputs som skickas på en gång ger ingen extra fart, servern
  kickar den som skickar skräppaket, och spelare utanför synhåll skickas aldrig.

### Vapenförmågor och legendariska krafter

Alla förmågor och alla legendariska krafter finns i multiplayer, med samma
siffror som i singleplayer (`server/abilities.js`). Servern kör dem, och alla i
närheten ser effekterna. Klonerna är egna figurer. Kraften skadar monster men
aldrig andra spelare, eftersom en legendarisk kraft annars skulle avgöra en
PvP-strid på egen hand. Nedkylningen sparas med karaktären, så den nollställs
inte om man loggar ut eller byter vapen. Fenix räddar dig en gång medan den är
redo, precis som i singleplayer.

### Pals

Pals finns i multiplayer (`server/pals.js`). Ägg droppar från bossar (alltid
första gången du besegrar en boss) och från elitmonster. Du kläcker dem i
Fristadens Pal Den och gör dem starkare med essens och material. Eftersom
Fristaden delas av alla bestämmer din nivå hur långt pals kan växa, på samma
sätt som Den-uppgraderingarna gör i singleplayer: Den tar emot dig från nivå
6, och de två sista stegen kräver också en besegrad boss. Palen som går med dig
körs av servern, så alla ser den. Den slåss, samlar trä och sten åt dig eller
följer bara med, och slås den ut vaknar den efter en stund. Pals sparas med
karaktären.

### Båtar och havet

Båtarna byggs i smedjan precis som i singleplayer: flotte, slup och galeon. Vid
stranden sjösätter du båten med Använd, och vid land går du i land. Båtens fart
och vatten förutsägs på klienten med samma regler som servern använder (läget
och farten kommer med varje snapshot), så seglingen känns lika direkt som att
gå. Hajar och sjöormar dyker upp runt den som seglar och anfaller bara folk i
båtar. Sjöormar kan ge ett Pal-ägg. Galeonens skrov tar en del av skadan, och
andra spelare ser din båt.

### Marknader

Marknaderna finns i multiplayer (`server/markets.js`, `src/mp/markets.js`).
Världen bestämmer var de står och hur de ser ut, så servern och varje klient
bygger samma murar, grindar och torn. Klienten krockar därför med dem direkt.
Servern styr tornen och folket och kontrollerar varje affär. Varje spelare har
sitt eget lager, som byts var tjugonde minut, och sitt eget rykte hos varje
marknad. Skadar du någon där vänder sig tornen mot dig, och ingen handlar med
dig på några minuter. Man kan inte bygga vid en marknad eller riva dess murar.

### Inte med i multiplayer än

Allt i singleplayer finns nu också i multiplayer. Det enda som saknas är
WebTransport (allt går via WebSocket).

### Bossar, upptäckter, vägstenen och forskning

Alla bossar har samma attacker som i singleplayer (`server/bosses.js`), med
samma tider och siffror: meteorregn, isringar med en lucka, piggrader,
blixtnedslag, rusningar, cirklande klot, dubbelgångare, gravitationsbrunnar,
rötter, sporer, sandvågor, vattenväggar och virvlar. Attackerna siktar på
bossens mål eller sprids över spelarna runt den, och de skadar alla som står där
de landar. Upptäcktsplatserna (benrester, vägskyltar, flaskpost, vrak, idoler,
begravda skatter) hittar var och en för sig. Vägstenen tar dig hem och tillbaka
från menyn. Komponenter forskas fram i Fristadens bibliotek och ger fler val i
smedjan och vid drops.

---

## 1. Grundprincip: servern bestämmer allt

```
 ┌──────────────┐  inputs (30/s)   ┌─────────────────────────────┐
 │ Klient (PWA) │ ───────────────▶ │ Spelserver (Node.js)        │
 │  - ritar     │                  │  - kör simuleringen 30 Hz   │
 │  - förutser  │ ◀─────────────── │  - äger all state           │
 │    egen gubbe│  snapshots       │  - SQLite för lagring       │
 └──────┬───────┘  (delta, binärt) └──────────────┬──────────────┘
        │ inloggning (JWT)                        │ verifierar JWT
        ▼                                         ▼
 ┌──────────────┐                        ┌──────────────────┐
 │ Supabase Auth│ ◀──── JWKS ─────────── │ nattlig backup → │
 │ e-post/Google│                        │ objektlagring    │
 │ /Discord     │                        └──────────────────┘
 └──────────────┘
```

**Klienten skickar bara vad spelaren vill göra**, till exempel "gå åt vänster",
"slå mot 40°" eller "bygg vägg på (12, -3)". Den skickar aldrig var den står,
vad den träffade eller vad den hittade. Servern räknar fram resultatet och
skickar tillbaka det. Det är den viktigaste regeln mot fusk: allt som klienten
inte får bestämma kan den inte heller fuska med.

### Delad simuleringskärna

Världen, rörelsen, striden och vapengeneratorn finns redan som JavaScript i
`src/game` och `src/weapons`. Samma kod ska köras både i webbläsaren och i Node:

- `src/sim/` ska innehålla ren spellogik. Den får inte använda DOM,
  `requestAnimationFrame`, `Date.now()` eller `Math.random()`. Klockan och
  slumpen skickas in utifrån. I dag finns cirka 140 sådana anrop i `src/game`,
  och det är det största jobbet i fas 0.
- Servern kör kärnan på riktigt. Klienten kör samma kärna för att förutse
  sin egen spelares rörelse, så att den känns omedelbar.
- Singleplayer fortsätter att fungera precis som nu och använder bara samma
  kärna lokalt.

### Världen skickas inte, bara ändringarna

Terrängen skapas deterministiskt från ett seed, eftersom `world.js` redan
fungerar så. Därför får klienten seedet när den ansluter och genererar marken
själv. Över nätet går bara ändringar:

- fällda träd och krossade stenar (med återväxt)
- byggen och golv
- förbrukade altare
- föremål på marken

Två saker följer av det:

- **Hemliga platser genereras från ett separat seed som bara servern har.**
  Det gäller altaren, skatter och ägg. Annars kunde vem som helst köra
  generatorn offline och få fram en karta över allt värdefullt. Klienten får
  bara se det som ligger inom synhåll.
- **Samma resultat i alla JavaScript-motorer.** `world.js` använder
  `Math.sin` och `Math.cos`, som i teorin kan avrunda olika i V8 (Chrome och
  Node) och JavaScriptCore (Safari). Därför lägger vi till ett test som
  jämför en hash av ett antal chunkar i Node, Chromium och WebKit. Servern har
  ändå alltid sista ordet om kollisioner, så en skillnad märks som en liten
  rättning och aldrig som fusk.

---

## 2. Nätkod: andra spelare ska inte lagga

Målet är att både din egen och andras rörelse ser mjuk ut, även med 150–200 ms
ping på mobilnät.

### Takt

| Vad | Takt |
|---|---|
| Serverns simulering | 30 tick/s (33 ms). Spelets 60 Hz-steg körs två gånger per tick |
| Input från klienten | 30 paket/s. Varje paket innehåller de tre senaste inputen, så att ett försenat paket inte gör att input saknas |
| Snapshots till klienten | 30/s för sådant nära dig, 10/s för sådant längre bort |
| Rendering på klienten | Skärmens egen takt (60/120 Hz) med interpolering |

### Din egen spelare: förutsägelse och avstämning

1. När du trycker åt vänster flyttar klienten din gubbe direkt, med samma kod
   som servern kör. Varje input får ett löpnummer och sparas i en historik.
2. Servern kör samma input och skickar tillbaka "senast behandlade input = 812,
   din position = (x, y)".
3. Klienten utgår från serverns position och spelar upp alla input efter 812
   igen. Oftast hamnar den på exakt samma ställe och ingenting syns.
4. Om rättningen är liten, till exempel efter en knuff, glider gubben dit under
   cirka 100 ms i stället för att hoppa. Om den är stor, som vid en
   teleportering, hoppar den direkt.

### Andra spelare och fiender: interpolering

- Andra spelare och fiender ritas cirka 100 ms bakåt i tiden, mellan två
  snapshots som klienten redan har fått. Rörelsen blir därför helt jämn trots
  att data kommer i ryck.
- Bufferten anpassas efter hur mycket fördröjningen varierar (jitter). På
  stabilt wifi är den runt 70 ms och på skakigt 4G upp till cirka 200 ms.
- Om en snapshot är sen fortsätter figuren i samma riktning i högst 100 ms och
  stannar sedan, i stället för att glida iväg.
- Klientens klocka synkas mot serverns med ping/pong (medianen av flera mätningar).

### Strid med lagkompensation

- Spelet har redan auto-aim, så en aimbot ger nästan ingen fördel. Det är bra
  för PvP.
- När du slår spelas animationen och träffgnistan upp direkt hos dig. Skadan
  och siffran kommer från servern 50–100 ms senare, vilket knappt märks.
- Servern sparar varje spelares position för den senaste sekunden. Ett slag
  kontrolleras mot där målet befann sig på din skärm, det vill säga
  serverns tid minus din fördröjning. Den här tillbakaspolningen är begränsad
  till 200 ms. Den som har sämre ping får sämre träffsäkerhet, så att ingen kan
  utnyttja en hög ping.
- Projektiler skapas på servern. Klienten visar en förutsedd kopia direkt och
  byter till serverns version när den kommer.

### Bandbredd och "interest management"

- Varje spelare får bara data om det som finns inom cirka 1,5 skärmar (chunkarna
  runt dig). Det sparar bandbredd och gör det omöjligt att se spelare genom
  väggar eller på kartan med ett hack, eftersom datan aldrig skickas.
- Protokollet är binärt (`ArrayBuffer`). Positioner packas till 1/16 ruta och
  bara det som har ändrats sedan den senaste bekräftade snapshoten skickas.
- Uppskattning:
  - En entitet tar cirka 9 byte och en spelare ser ungefär 40 entiteter, vilket
    blir högst cirka 10 kB/s per spelare. Det motsvarar runt 36 MB per timme
    på mobil.
  - 50 spelare blir cirka 0,5 MB/s ut från servern, långt under vad gratistjänsterna
    nedan tillåter.

### Transport

- **Fas 1–6 använder WebSocket**, eftersom det fungerar överallt, även i Safari
  och på iOS och genom Cloudflare.
- **WebTransport är en möjlig senare uppgradering.** Det har UDP-liknande
  datagram, så ett tappat paket inte stoppar upp de som kommer efter. Protokollet
  skrivs så att transporten går att byta ut.

### Verktyg för att mäta lagg

- **Debugpanel** (`?debug=1`): visar ping, jitter, interpoleringsbuffert,
  rättningar per sekund och bytes per sekund.
- **Nätsimulator i utvecklingsläget**: lägger på konstgjord fördröjning,
  jitter och stopp, så att det går att testa till exempel 200 ms ping lokalt.
- **Bot-test i CI**: två huvudlösa klienter rör sig samtidigt och testet mäter
  hur stora rättningarna blir. Om de växer efter en ändring underkänns testet.

---

## 3. Fusk och exploits

| Exploit | Skydd |
|---|---|
| Speedhack eller teleportering | Klienten skickar riktning, inte position. Riktningen begränsas till längd 1 och servern räknar själv ut fart och kollision |
| Skicka extra input för att springa fortare | Servern godtar högst ett input per tick plus en liten buffert. Det som är för mycket kastas, och klientens egna tidsstämplar litar servern inte på |
| Gå genom väggar | Servern kör kollisionen. Klientens förutsägelse rättas |
| Ändra skada eller cooldown | Vapnets DNA finns på servern och servern räknar skada och cooldowns. Klienten säger bara "jag slog åt 40° vid tick T" |
| Träffa från för långt håll | Räckvidden kontrolleras med lagkompensation som är begränsad till 200 ms |
| Förutse loot | Vapen och drops slumpas på servern med kryptografisk slump per drop. Inget seed för loot når klienten |
| Map hack eller ESP | Interest management: det som inte syns skickas aldrig. Altaren och skatter kommer från ett hemligt seed. Klanmedlemmar är de enda som syns på kartan |
| Duplicering | Alla ändringar i inventory är SQLite-transaktioner. Varje föremål har ett unikt id och kan bara ligga på ett ställe. Byten är atomiska och båda parter godkänner slutläget. Alla förflyttningar loggas i en huvudbok |
| Logga ut för att undgå döden (combat logging) | Den som loggar ut i vildmarken lämnar kvar en sovande kropp i 30 sekunder som kan dödas. I Fristaden loggar man ut direkt |
| Döda nyss återupplivade spelare (spawn camping) | 10 sekunders skydd efter respawn som försvinner direkt om man själv attackerar |
| Bygga på otillåtna ställen | Servern kör samma `placementProblem` som i dag, plus kontroller av claims och kostnad |
| Skräppaket eller flooding | Paketen kontrolleras mot ett schema med storleksgräns, och varje meddelandetyp har en hastighetsgräns. Den som bryter mot det kickas. Antalet anslutningar per konto och IP är begränsat |
| Kapade konton | Servern verifierar JWT med JWKS och tar konto-id från tokenet, aldrig från klienten |
| DDoS | Cloudflare (gratis) står framför servern och döljer dess IP-adress |
| Oupptäckt fusk | Servern varnar vid misstänkta mönster, till exempel essence per timme eller kills per minut. Det finns också admin-kommandon för kick och ban och en revisionslogg |

Att obfuskera klientkoden ger inget skydd och lägger vi inte tid på.
Säkerheten kommer från att servern bestämmer.

---

## 4. Klaner och baser

### Klaner

- Klanen har ett namn och en tagg, till exempel `[ULV]`, och högst 8
  medlemmar. Takets storlek går att ställa in, men ett tak hindrar en enda
  megaklan på en server med 50 spelare.
- Det finns tre roller:
  - **Ledare**: allt, inklusive att upplösa klanen och utse en ny ledare.
  - **Officer**: bjuda in och kicka, bygga och riva, öppna klanvalvet.
  - **Medlem**: bygga, använda byggnader och lägga in saker i valvet.
- Klanmedlemmar syns på kartan och i kompassen, har en egen klanchatt och kan
  inte skada varandra.

### Baser

- **Fristaden** vid spawn ersätter singleplayerns läger. Den är säker, utan PvP,
  och har en marknad och en enkel forge. Där kan man inte bygga.
- **Klanbanér**: en klan bygger ett banér ute i vildmarken. Banéret gör anspråk
  på en cirkel med radien 16 rutor (en claim).
  - Inom en claim kan bara klanen bygga, öppna grindar och använda förråd.
  - En claim måste ligga minst 40 rutor från Fristaden och från andra claims.
  - Varje klan kan ha en claim. En spelare som spelar ensam är en klan med en
    medlem.
- **Byggnaderna är gemensamma.** Forge, Pal Den, Vault, bibliotek och de andra
  byggs och uppgraderas med klanens resurser i klanvalvet. Den egna
  ryggsäcken och de egna vapnen är fortfarande personliga.
- **Underhåll:** banéret drar lite trä, sten och essence varje vecka. Om ingen
  betalar förfaller basen långsamt, så att övergivna baser inte blir kvar för
  alltid.
- Murar, turrets, fällor och golv fungerar som i dag. Det befintliga
  byggläget och mobilflödet återanvänds. Turrets skjuter mot fiender och mot
  spelare från andra klaner som är inne i claimen när basen går att raida.

---

## 5. PvP-regler och raidskydd

### Zoner

| Zon | PvP | Byggen |
|---|---|---|
| Fristaden | Nej | Nej |
| Vildmarken | Ja, fri PvP | Bara inom egen claim |
| En claim | Ja. Ägarnas byggen kan bara skadas när basen går att raida | Bara klanen |

### När en bas går att raida

En bas kan bara skadas av andra spelare om något av följande gäller:

1. **Någon i klanen är online**, eller har loggat ut för mindre än 15 minuter
   sedan. Fördröjningen hindrar att man loggar ut så fort man ser raiders komma.
2. **Det är serverns raidfönster**, förslagsvis lördagar 18–21 svensk tid.
   Fönstret går att ställa in eller stänga av per server.

Utanför de lägena tar murar och byggnader ingen skada från spelare. Fiender och
bossar påverkas inte av reglerna.

- När en raid börjar får försvararna en varning i spelet. Som tillval kan
  varningen också skickas till en Discord-webhook.
- Hälften av innehållet i klanvalvet är alltid skyddat och kan inte lootas. En
  förlorad raid svider då utan att förstöra veckor av spelande. Andelen går att
  ställa in.

### Död och nya spelare

- **Döden i vildmarken:** du tappar 50 % av de resurser du bär (trä, sten,
  essence och så vidare) i en säck som andra kan plocka upp. Vapnen i din
  loadout behåller du.
  - En server kan slå på läget *hardcore*. Då tappar man också vapen som inte
    är utrustade.
- **Nybörjarskydd:** den som har spelat mindre än två timmar, eller inte har
  besegrat sin första boss, kan inte skadas av andra spelare och kan inte själv
  skada andra spelare. Den som attackerar en spelare förlorar skyddet direkt.
- **Bossar och altare:**
  - En boss kan fortfarande besegras en gång per altare. I multiplayer gäller
    det hela servern: altaret förbrukas för alla.
  - Eftersom altarna genereras oändligt finns det alltid ett nytt.
  - Alla som har gjort minst 10 % av skadan får egen loot, så det går inte att
    stjäla en kill.
  - Det blir naturliga PvP-heta platser: vem tar altaret först?
- **Pals** följer med i multiplayer. Servern styr dem och de räknas in i
  entitetsbudgeten, med högst en aktiv pal per spelare.

---

## 6. Konton och lagring

### Inloggning

- Inloggningen sköts av **Supabase Auth**, med e-post (magisk länk), Google och
  Discord.
- Klienten får en JWT och skickar den när WebSocket-anslutningen öppnas.
  Servern verifierar signaturen mot Supabases JWKS.
- Servern lagrar inga lösenord.

### Speldata

Speldatan ligger i **SQLite på spelservern** i WAL-läge, via `better-sqlite3`.
Tabeller:

| Tabell | Innehåll |
|---|---|
| `accounts` | konto-id (från JWT), visningsnamn, ban-status |
| `characters` | en MP-karaktär per konto och server: position, hp, resurser, loadout |
| `items` | unikt id, ägare (karaktär, valv eller mark), vapnets DNA som JSON, `GENERATOR_VERSION` |
| `clans`, `clan_members` | klaner och roller |
| `claims`, `structures`, `floors` | baser |
| `world_deltas` | fällda träd, förbrukade altare och liknande per chunk |
| `ledger` | varje förflyttning av föremål och resurser, för att spåra duplicering |

### Sparning och backup

- Ändrad data skrivs i en transaktion var tionde sekund.
- Viktiga händelser sparas direkt: byten, legendariska drops, död och raid.
- En nattlig backup görs med `VACUUM INTO` till gratis objektlagring, och de
  senaste 14 dagarna sparas.
- Singleplayer-sparfilen i IndexedDB påverkas inte. I huvudmenyn leder
  Multiplayer till inloggning, sedan en serverlista och sedan skapandet av en
  karaktär.

### Versioner

- Klienten och servern har ett gemensamt protokollnummer.
- Om servern har ett nyare nummer använder klienten PWA:ns befintliga
  uppdateringsflöde ("Ny version, ladda om") innan den ansluter.
- Vapnens DNA sparas med `GENERATOR_VERSION`, som redan i dag.

---

## 7. Gratis hosting

Uppgifterna gäller oktober 2026. Gratisnivåer ändras ofta, så kontrollera
villkoren igen innan något sätts upp.

### Rekommendation (0 kr/mån)

| Del | Tjänst | Varför |
|---|---|---|
| Klienten (statisk PWA) | **Cloudflare Pages** eller Workers static assets | Statiska filer är gratis utan bandbreddstak. Global CDN och HTTPS |
| Spelservern | **Oracle Cloud Always Free**, ARM-VM i regionen Stockholm | En riktig server som alltid är igång. Från 15 juni 2026 har gratiskonton 2 OCPU och 12 GB RAM, och Oracle anger cirka 10 TB trafik ut per månad. Det räcker gott för 50 spelare |
| TLS, DDoS-skydd och dold IP | **Cloudflare Tunnel** (gratis) framför servern | Inga öppna portar och WebSocket fungerar |
| Inloggning | **Supabase**, gratisnivå | 50 000 aktiva användare per månad samt e-post, Google och Discord |
| Backup | Oracles Object Storage eller Cloudflare R2 (båda har gratisnivå) | Nattlig kopia av SQLite-filen |

#### Fällor att känna till

- **Oracle**
  - Registreringen kräver ett kort för verifiering.
  - ARM-maskiner kan vara slut ("out of capacity") i populära regioner. Då får
    man försöka igen eller välja en annan hemregion. Gratisresurser finns bara
    i hemregionen, som väljs vid registreringen.
  - Oracle stänger gratis-VM:ar som är "idle" i 7 dagar (under 20 % CPU,
    nätverk och minne), och en liten spelserver kan räknas som idle. Det går
    att undvika genom att uppgradera kontot till Pay As You Go. Det kostar
    fortfarande 0 kr inom gratisgränserna, men lägg in en budgetvarning på 1 kr.
  - Oracle halverade gratiskvoten i juni 2026 utan att meddela det i förväg.
    Därför ska servern gå att flytta: den körs i Docker och har backups, så att
    flytten tar en timme om villkoren ändras igen.
- **Supabase**
  - Ett gratisprojekt pausas efter 7 dagar utan anrop. Spelservern kan göra
    ett anrop per dygn för att hålla det vaket.

### Plan B: Cloudflare Workers + Durable Objects

Varje spelserver blir ett Durable Object som tar emot WebSockets. Servern är
redan JavaScript, så flytten är rimlig. Gratisplanen har dock tydliga tak:

- **Anrop:** 100 000 per dygn. Inkommande WebSocket-meddelanden räknas 20:1,
  vilket ger cirka 2 miljoner meddelanden per dygn.
  - Med 10 spelare och 30 inputpaket/s är det slut efter knappt 2 timmar.
  - Om varje paket innehåller tre input (10 paket/s) räcker det cirka 5,5
    timmar per dygn.
- **Körtid:** 13 000 GB-s per dygn, vilket räcker till ungefär ett Durable
  Object igång dygnet runt. Fler servrar ryms inte.

Det fungerar för en vänskapsgrupp som spelar några timmar per kväll, men
marginalen är liten. Workers Paid (5 USD/mån) tar bort problemet.

### Plan C: egen dator eller Raspberry Pi hemma

En egen dator eller en Raspberry Pi med **Cloudflare Tunnel** kostar inget och
har inga gränser, och fördröjningen blir låg om alla bor i Sverige. Nackdelen
är att maskinen måste vara igång och att hemmets uppladdningshastighet sätter
taket. Det är bra för tester och små kvällar.

### Avråds

| Tjänst | Varför |
|---|---|
| Fly.io | Ingen gratisnivå för nya konton, bara en kort provperiod |
| Render (gratis) | Somnar efter 15 minuter utan trafik, saknar beständig disk och har 512 MB RAM. Duger bara till tester |
| Google Cloud e2-micro | Gratis bara i USA-regioner, vilket ger för hög ping från Sverige för PvP |

---

## 8. Färdplan

Varje fas avslutas med tester, och singleplayer måste fungera hela vägen.

| Fas | Innehåll | Klart när | Storlek |
|---|---|---|---|
| **0. Förberedelse** | Flytta spellogiken till `src/sim/` utan DOM eller klocka, med klocka och RNG som injiceras. Gör rörelsen till en ren funktion `stepPlayer(state, input, dt, world)`. Lägg till ett determinismtest över motorer (Node, Chromium, WebKit) | Simuleringen kör huvudlöst i Node i unit-testerna, och singleplayer beter sig som förut | Stor |
| **1. Rörelseprototyp** | Node-server med `ws`, anslutning med smeknamn, 30 Hz tick, förutsägelse, avstämning, interpolering, debugpanel och nätsimulator | Med 200 ms simulerad ping känns den egna rörelsen omedelbar och andra rör sig jämnt. Bot-testet i CI mäter rättningarna | Medel |
| **2. Auktoritativ strid** | Fiender, attacker, förmågor och projektiler på servern, lagkompensation, loot och vapengenerering på servern, plockning av föremål | Bot-tester visar att man inte kan slå för långt, för ofta eller förutse loot | Stor |
| **3. Konton och lagring** | Supabase Auth, MP-karaktär, SQLite, transaktioner, huvudbok och backup | Ett byte som kraschas mitt i tappar eller dubblerar inget. Detta testas med bots och kill -9 | Medel |
| **4. Klaner och baser** | Klaner, roller, chatt, banér och claims, gemensamma byggnader, klanvalv och underhåll | Två klaner kan bygga sida vid sida utan att kunna röra varandras saker | Medel |
| **5. PvP och raidskydd** | Zoner, raidregler med raidfönster och 15-minutersfördröjning, dödssäck, sovande kropp, nybörjar- och spawnskydd, raidvarning | Alla regler i avsnitt 5 är täckta av tester | Medel |
| **6. Drift och beta** | Oracle, Cloudflare Tunnel och Pages, healthcheck, loggar, admin-kommandon, lasttest med 50 bots, stängd beta med vänner | 50 bots i 1 timme med stabil tick och låg rättningsfrekvens | Liten–medel |

---

## 9. Att bestämma senare

Det här behöver inte bestämmas nu. Allt är gjort för att kunna ställas in per
server.

- **Raidfönster:** vilka dagar och tider, eller inget fönster alls?
- **Död:** är 50 % av det man bär rätt, eller ska servern ha hardcore-läge?
- **Klaner:** är 8 medlemmar rätt tak?
- **Båtar och hav:** ska sjöstrider finnas med från början eller komma senare?
- **Servrar:** en officiell server, eller ska vänner kunna starta egna?
