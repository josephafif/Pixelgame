# Så sätter du upp multiplayer

Allt är gratis, och inget av det kräver betalkort:

| Del | Var | Kostnad |
|---|---|---|
| Spelet (webbsidan) | Netlify: <https://pixelgame-infinite-arsenal.netlify.app> (redan igång) | 0 kr |
| Den officiella servern, alltid öppen | Cloudflare Workers, gratisplanen | 0 kr, inget kort |
| Serverlistan, koderna och inloggning med Discord/Google | Supabase, gratisplanen | 0 kr |
| Servrar som spelare kör själva | Spelarens egen dator (`npm run share`) | 0 kr |

Gratisplanerna kan aldrig kosta pengar. Når man taket slutar tjänsten svara tills nästa dygn.

Du gör steg 1 och 2 en gång. Sedan uppdateras webbsidan och den officiella servern av sig
själva varje gång något pushas till GitHub.

---

## 1. Supabase (serverlistan och inloggningen)

Supabase-projektet *Pixelgame* finns, och spelet känner till det (`src/config.js`).
Serverlistan är redan upplagd: tabellen `game_servers` med migreringarna i
`supabase/migrations/`, och Edge-funktionen `game-servers` från
`supabase/functions/game-servers/`. Behöver något läggas upp igen, kör i spelets mapp:

```bash
supabase db push
supabase functions deploy game-servers --no-verify-jwt
```

### Valfritt: logga in med Google

Utan detta loggar alla in med namn och lösenord. Det fungerar bra. Med ett Google-konto kan
man spela med samma karaktär från alla sina enheter utan lösenord. Supabase kan inte slå på
Google själv: det behöver ett eget *OAuth-klient-ID* från ditt Google-konto. Så här gör du:

1. **Google Cloud.** Gå till <https://console.cloud.google.com> och logga in med ditt
   Google-konto.
   - Skapa ett projekt uppe till vänster (**Select a project → New project**), till exempel
     *Pixelgame*.
2. **Samtyckesskärmen.** Sök på *Google Auth Platform* (eller gå till **APIs & Services →
   OAuth consent screen**) och tryck på **Get started**.
   - *App name:* `Pixelgame`. *User support email:* din e-post.
   - *Audience:* **External**. *Contact information:* din e-post. Godkänn villkoren och
     tryck på **Create**.
3. **Klienten.** Gå till **Clients → Create client** (eller **Credentials → Create
   credentials → OAuth client ID**).
   - *Application type:* **Web application**. *Name:* `Pixelgame`.
   - *Authorized JavaScript origins:* `https://pixelgame-infinite-arsenal.netlify.app`
   - *Authorized redirect URIs:* `https://tqctqccltthwlhfdwkre.supabase.co/auth/v1/callback`
   - Tryck på **Create**. Kopiera **Client ID** och **Client secret**.
4. **Publicera.** Under **Audience** trycker du på **Publish app**. Annars kan bara de
   e-postadresser du lagt till som testanvändare logga in. Spelet ber bara om namn och
   e-post, så Google behöver inte granska appen.
5. **Supabase.** Öppna **Authentication → Sign In / Providers → Google**.
   - Slå på **Enable Sign in with Google**.
   - Klistra in Client ID i *Client IDs* och Client secret i *Client Secret (for OAuth)*.
   - Tryck på **Save**. Det går inte att spara utan båda.
6. **Supabase, adresser.** Under **Authentication → URL Configuration**:
   - *Site URL:* `https://pixelgame-infinite-arsenal.netlify.app`
   - *Redirect URLs:* lägg till `https://pixelgame-infinite-arsenal.netlify.app/?mp=auth`

Knappen **Logga in med Google** dyker upp i lobbyn under *Officiell server* av sig själv.
Logga in där för att prova: lobbyn visar sedan *Inloggad som …*.

**Discord** fungerar på samma sätt: skapa en app på
<https://discord.com/developers/applications>. Under OAuth2 lägger du till Redirect
`https://tqctqccltthwlhfdwkre.supabase.co/auth/v1/callback`. Kopiera *Client ID* och *Client
Secret* till **Supabase → Sign In / Providers → Discord**.

**E-post** fungerar inte direkt. Supabases inbyggda e-post skickar bara till projektets egna
medlemmar. Vill du ha det: lägg in en egen avsändare under **Authentication → Emails → SMTP**,
till exempel Resend eller Brevo, som båda har gratisnivåer. Sätt sedan `emailLogin: true` i
`src/config.js`.

---

## 2. Den officiella servern (Cloudflare, alltid öppen)

Servern körs som en *Durable Object* på Cloudflares gratisplan. Det är samma serverkod som
annars, med databasen i Cloudflare. När ingen spelar sover världen, och den vaknar på några
millisekunder när någon ansluter. Du behöver ingen server och inget betalkort.

1. Skapa ett gratiskonto på <https://dash.cloudflare.com/sign-up>.
2. Lägg upp servern på ett av två sätt:
   - **Utan terminal (rekommenderat):** gå till **Workers & Pages** (under *Compute* i
     menyn) och tryck på **Create → Import a repository**. Koppla GitHub och ge Cloudflare
     tillgång till `josephafif/Pixelgame`. Välj repot och fyll i:
     - *Project name:* `pixelgame`. Det måste vara exakt det namnet, annars stoppar bygget.
     - *Build command:* lämna tomt.
     - *Deploy command:* `npx wrangler deploy`
     - Grenen är `ccr-416322ef-rg7mbc`, som är repots enda gren.
     Tryck på **Create and deploy** och vänta ett par minuter. Sedan uppdateras servern vid
     varje push. Frågar Cloudflare efter en *workers.dev-subdomän*, välj vad du vill, till
     exempel ditt namn.
   - **Med terminal:** kör `npx wrangler login` och sedan `npm run cloud:deploy`.
3. Cloudflare visar adressen, till exempel `https://pixelgame.ditt-namn.workers.dev`. Öppna
   `…/health`. Den ska svara `{"ok":true,…}`.
4. Berätta för spelet var servern finns. Lägg till den i `src/config.js` och pusha:
   ```js
   servers: [{ name: 'Pixelgame', url: 'wss://pixelgame.ditt-namn.workers.dev/ws', official: true }],
   ```
   Du kan också bara skicka adressen till mig, så lägger jag in den.
5. **Admin:** öppna **Workers & Pages → pixelgame → Settings → Variables and Secrets** och
   lägg till variabeln `ADMINS`. Värdet är ditt spelarnamn, eller din e-post om du loggar in
   med Discord eller Google. Skapa din karaktär först, så att ingen annan hinner ta namnet.

### Gratisplanens gränser

| Vad | Gräns per dygn | Vad det räcker till |
|---|---|---|
| Förfrågningar | 100 000. 20 meddelanden från spelare räknas som en | cirka 37 spelartimmar per dygn, till exempel 6 vänner som spelar 6 timmar var |
| Körtid | 13 000 GB-s | en värld dygnet runt (cirka 28 timmar) |
| Databas | 100 000 skrivna rader, 5 GB totalt | gott och väl |

- Därför skickar spelet sin styrning 15 gånger i sekunden till den här servern, i stället för
  30. Servern simulerar fortfarande 30 gånger i sekunden och skickar 30 uppdateringar i
  sekunden till varje spelare. Det märks inte.
- `/health` visar `requestsToday`, alltså ungefär hur mycket av dagens kvot som har gått åt.
- Om taket nås slutar servern svara till midnatt UTC (klockan 01 eller 02 svensk tid). Inget
  försvinner och inget kostar något.
- Klanbasernas underhåll dras även för de timmar då världen sover.

---

## 3. Servrar som spelare kör själva (`npm run share`)

Vem som helst kan köra en egen server på sin dator och spela med sina vänner via webbsidan.
Det kräver inget konto och inga inställningar i routern.

### Första gången

1. Installera **Node.js 22 eller nyare** från <https://nodejs.org> (välj LTS).
2. Hämta spelet: `git clone https://github.com/josephafif/Pixelgame.git`, eller **Code →
   Download ZIP** på GitHub och packa upp.
3. Öppna en terminal i mappen (på Windows: högerklicka i mappen → *Öppna i terminal*) och kör:
   ```bash
   npm install
   npm run share
   ```
   Första gången hämtas Cloudflares tunnelprogram (`cloudflared`, cirka 40 MB) till
   `server-data/bin/`. Har du redan `cloudflared` installerat används det.
4. Efter några sekunder visas en ruta:
   ```
   Serverns kod:           K7QX2M
   Skicka länken:          https://pixelgame-infinite-arsenal.netlify.app/?join=K7QX2M
   Spela själv (admin):    http://localhost:8787
   ```

### Spela

- **Dina vänner** öppnar länken, eller går till webbsidan och skriver koden under
  **Multiplayer → Spela på en väns server**. De trycker på **Spela som gäst** och väljer ett namn
  och ett lösenord.
- **Du** öppnar <http://localhost:8787> på samma dator. Där är du admin: skriv `/help` i
  chatten (öppnas med T) för att se kommandona.
- **Stäng av** med Ctrl+C. Servern sparar allt först och försvinner ur listan.
- **Nästa gång:** kör `npm run share` igen. Koden och länken är desamma. Den som spelat förut
  trycker på **Fortsätt som gäst**. Från en annan enhet: **Logga in med namn**.
- **Visa servern för alla** i listan *Öppna servrar*: `npm run share -- --public`.

### Bra att veta

- **Datorn måste vara på** och vaken medan ni spelar. Stäng av viloläget under tiden.
- **Internet:** varje spelare använder cirka 10 kB/s (80 kbit/s) av din uppladdning. 20
  spelare klarar de flesta bredband.
- **Tunneln** är Cloudflares gratistjänst för tester (*Quick Tunnels*). Den har ingen
  drifttidsgaranti och tar högst 200 samtidiga anslutningar. Det räcker gott för en
  kompisserver. Går tunneln ner startar skriptet en ny, och koden fortsätter att fungera.
- **Säkerhet:** servern lyssnar bara på din egen dator, och tunneln är enda vägen in. Inga
  portar öppnas i routern. Lösenorden sparas som saltade scrypt-hashar. Spelarnas
  Discord- och Google-inloggning skickas aldrig till servrar som spelare kör, bara till den
  officiella.
- **Koden** och nyckeln som bevisar att den är din ligger i `server-data/host.json`. Radera
  filen om du vill ha en ny kod.
- **Sparat:** allt ligger i `server-data/pixelgame.db`. Varje dygn sparas en kopia i
  `server-data/backups/`.
- **Inställningar:** `--name "Vår server"` byter namn, `--port 8788` byter port och
  `--no-tunnel` startar bara för din egen dator. Skriv dem efter `npm run share --`.
- **Utan serverlistan** (om Supabase inte svarar) skriver skriptet ut tunnelns egen länk i
  stället. Den fungerar också, men byts varje gång.

## 4. Alternativ: en egen Linux-server

Behövs bara om Cloudflares gratisplan inte räcker, till exempel med många spelare varje dag.
Samma spel, med en vanlig server i stället för Cloudflare.

| Del | Tjänst | Kostnad |
|---|---|---|
| Spelservern, som också levererar själva spelet | Oracle Cloud Always Free (en ARM-server i Stockholm), eller en annan VPS | 0 kr hos Oracle, men kräver betalkort för verifiering |
| En adress med HTTPS | DuckDNS och Caddy, eller en egen domän via Cloudflare | 0 kr, eller cirka 100 kr/år med egen domän |
| Inloggning med Discord och Google (valfritt) | Supabase-projektet från del 1 | 0 kr |

Oracle stänger gratisservrar som verkar oanvända en vecka, om kontot inte är uppgraderat till
*Pay As You Go*. Därför är Cloudflare (del 2) förstahandsvalet.

### Steg 0: prova lokalt (5 minuter)

```bash
npm install
npm run mp
```

Öppna sedan <http://localhost:8787> och tryck på **Multiplayer** och sedan
**Spela som gäst**. Öppna ett privat webbläsarfönster till för att se en andra
spelare.

I det här läget gäller följande:
- Alla får använda admin-kommandon, till exempel `/tp 100 0` och `/give scrap 500`.
  Skriv `/help` i chatten (öppnas med T).
- Datan sparas i `server-data/dev.db`. Radera mappen om du vill börja om.

Andra kommandon som är bra att känna till:

```bash
npm run test:mp                                   # bottester mot en riktig server
node scripts/loadtest.mjs --bots 50 --seconds 30  # lasttest
```

---

### Steg 1: Supabase (valfritt)

Använd projektet från del 1. Servern behöver dess adress och publishable key, i
`server/.env` (se steg 3). Lägg också till serverns adress, med `/?mp=auth` på slutet, under
Redirect URLs om du vill kunna logga in med Discord eller Google där.

---

### Steg 2: Oracle Cloud (servern)

1. Skapa ett konto på <https://www.oracle.com/cloud/free/>. Du behöver ett
   betalkort för verifiering, men inget dras.
   - Välj **Sweden Central (Stockholm)** som *home region*. Det går inte att
     ändra senare, och gratisresurserna finns bara där.
2. **Rekommenderat:** uppgradera kontot till *Pay As You Go* och lägg in en
   budgetvarning på 1 USD (Billing → Budgets).
   - Det kostar fortfarande 0 kr så länge du håller dig inom Always Free.
   - Gratiskonton får annars sina servrar stängda om de verkar oanvända en
     vecka, och en liten spelserver kan räknas som oanvänd.
3. Skapa servern under **Compute → Instances → Create instance**:
   - **Image:** Ubuntu 24.04.
   - **Shape:** Ampere, `VM.Standard.A1.Flex`, med 2 OCPU och 12 GB minne.
   - **SSH:** ladda ner nyckeln eller klistra in din egen.
   - Om det står *Out of capacity*: försök igen senare eller välj en annan
     *availability domain*.
4. Notera serverns **publika IP-adress** och logga in:
   `ssh -i nyckel.key ubuntu@<ip>`

---

### Steg 3: installera spelet på servern

Kör följande på servern:

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker

# Spelet (för ett privat repo: använd en deploy-nyckel eller en token)
git clone https://github.com/josephafif/pixelgame.git Pixelgame
cd Pixelgame
cp server/.env.example server/.env
nano server/.env
```

Fyll i minst följande i `server/.env`:

```
SERVER_NAME=Vår Pixelgame-server
SUPABASE_URL=https://abcd.supabase.co
SUPABASE_ANON_KEY=din-anon-key
ALLOWED_ORIGINS=https://pixelgame.duckdns.org
ADMINS=din@epost.se
ALLOW_GUESTS=0
```

Utan Supabase: lämna de två `SUPABASE`-raderna tomma, sätt `ALLOW_GUESTS=1` och skriv ditt
spelarnamn i `ADMINS`. Skapa din karaktär först, så att ingen annan hinner ta namnet.

#### Alternativ 1, 0 kr: DuckDNS och Caddy

1. Logga in på <https://www.duckdns.org>, skapa ett namn (till exempel
   `pixelgame`) och skriv in serverns IP-adress.
2. Öppna port 80 och 443:
   - **Hos Oracle:** gå till Networking → Virtual Cloud Networks → ditt VCN →
     Security Lists → Default. Lägg till två *Ingress rules*, en för TCP 80 och
     en för TCP 443, med källa `0.0.0.0/0`.
   - **I Ubuntu på servern** (Oracles Ubuntu-avbilder har en egen brandvägg):
     ```bash
     sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
3. Skapa filen `.env` bredvid `docker-compose.yml`, alltså i mappen
   `Pixelgame`, med raden `DOMAIN=pixelgame.duckdns.org`.
4. Starta:
   ```bash
   docker compose --profile caddy up -d --build
   ```
   Caddy hämtar ett HTTPS-certifikat själv. Efter någon minut ska
   <https://pixelgame.duckdns.org/health> svara `{"ok":true,...}`.

#### Alternativ 2, egen domän: Cloudflare Tunnel

Det här ger skydd mot överbelastningsattacker, döljer serverns IP-adress och
kräver inga öppna portar. Du behöver en domän som ligger hos Cloudflare.

1. Gå till **Zero Trust → Networks → Tunnels → Create a tunnel** och välj
   Cloudflared.
2. Kopiera tunnelns token och spara den som `TUNNEL_TOKEN=...` i `.env` bredvid
   `docker-compose.yml`.
3. Lägg till ett **Public hostname**, till exempel `spel.dindoman.se`, med
   tjänsten `http://game:8787`.
4. Starta:
   ```bash
   docker compose --profile tunnel up -d --build
   ```

---

### Steg 4: fyll i inställningarna i spelet

Servern levererar spelet själv, så alla spelar på samma adress:
<https://pixelgame.duckdns.org>. Spelet behöver bara känna till Supabase.

1. Öppna `src/config.js` och fyll i `mp`:
   ```js
   mp: {
     servers: [],   // tomt: lobbyn visar servern som spelet kommer ifrån
     supabaseUrl: 'https://abcd.supabase.co',
     supabaseAnonKey: 'din-anon-key',
   },
   ```
2. Kör `npm run build` och committa. Hämta sedan ändringen på servern:
   ```bash
   cd ~/Pixelgame && git pull && docker compose --profile caddy up -d --build
   ```

#### Valfritt: spelet på Cloudflare Pages

Om du vill att spelet laddas från Cloudflares CDN i stället:

1. Koppla repot under **Workers & Pages → Create → Pages**.
2. Ställ in **Build command** `npm run dist`, **Output** `dist` och miljövariabeln
   `NODE_VERSION=22`.
3. Lägg till servern i `mp.servers`:
   `{ name: 'Vår server', url: 'wss://pixelgame.duckdns.org/ws' }`.
4. Lägg till `https://<projekt>.pages.dev` i `ALLOWED_ORIGINS` och i Supabases
   Redirect URLs (med `/?mp=auth` på slutet).

---

### Steg 5: spela

1. Öppna spelet, tryck på **Multiplayer**, logga in och tryck på **Spela**.
2. Välj ditt namn. Det går inte att byta senare.
3. Öppna **Klan** (B, eller via menyn), grunda en klan och bjud in dina vänner
   med deras spelarnamn.
4. Gå ut i vildmarken, minst 40 rutor från Fristaden, tryck på **Bygg** (G) och
   res klanbanéret. Sedan kan ni bygga murar, grindar och torn inom marken.

---

## Drift

### Den officiella servern (Cloudflare)

| Vad | Hur |
|---|---|
| Se loggen | **Workers & Pages → pixelgame → Logs**, eller `npx wrangler tail` |
| Hälsa och dagens kvot | `https://pixelgame.ditt-namn.workers.dev/health` |
| Uppdatera | Pusha till GitHub (med Git-kopplingen), eller `npm run cloud:deploy`. Spelarna kopplas ifrån en kort stund och kommer tillbaka på samma ställe |
| Ändra inställningar | **Settings → Variables and Secrets**, till exempel `ADMINS`, `MAX_PLAYERS` och `RULE_RAID_WINDOW` (samma namn som i `server/.env.example`) |
| Prova lokalt | `npm run cloud:dev`, sedan `node scripts/loadtest.mjs --bots 5 --url ws://localhost:8787/ws` |

### En egen Linux-server

| Vad | Hur |
|---|---|
| Se loggen | `docker compose logs -f game` |
| Uppdatera | `git pull && docker compose --profile caddy up -d --build`. Servern sparar allt innan den startar om |
| Backup | Servern sparar en kopia av databasen varje natt i `server-data/backups` och behåller 14 dagar. För att kopiera dem till en annan plats: installera rclone, kör `rclone config` och skapa till exempel en R2-, Google Drive- eller Oracle-remote som heter `backup`. Lägg sedan in `deploy/backup-offsite.sh` i crontab |
| Återställa | Stoppa servern och kopiera en backup till `server-data/pixelgame.db` |
| Övervakning | Lägg in `https://din-adress/health` hos <https://uptimerobot.com> (gratis). Då får du ett mejl om servern går ner |
| Admin i spelet | Skriv i chatten (T): `/kick namn`, `/ban namn timmar orsak`, `/unban namn`, `/tp x y`, `/give scrap 100`, `/announce text`, `/save`, `/password namn nyttlösenord` (när någon glömt sitt lösenord) |
| Raidvarningar till Discord | Sätt `DISCORD_WEBHOOK_URL` i `server/.env` |
| Utan Docker | `deploy/pixelgame.service` är en systemd-tjänst. Den behöver Node 22 och `npm ci --omit=dev` |

## Felsökning

### `npm run share`

- **"Servern behöver Node.js 22 eller nyare":** installera den senaste LTS-versionen från
  <https://nodejs.org> och öppna en ny terminal.
- **"Port 8787 används redan":** servern körs redan i ett annat fönster. Stäng det, eller kör
  `npm run share -- --port 8788`.
- **"Tunneln startade inte":** kontrollera internetanslutningen. Vissa skol- och
  jobbnätverk stoppar port 7844, som tunneln använder. Prova ett annat nät, till exempel
  mobilen som surfzon.
- **"Kunde inte hämta cloudflared":** installera det själv (Windows:
  `winget install --id Cloudflare.cloudflared`, macOS: `brew install cloudflared`) och kör
  `npm run share` igen.
- **Länken visar ett Cloudflare-fel (530 eller 1033):** tunneln har stängts. Titta i
  terminalen: skriptet startar en ny och skriver ut den nya länken.
- **En vän har glömt sitt lösenord:** öppna <http://localhost:8787> och skriv
  `/password Namn nyttlösenord` i chatten.

### Den officiella servern och serverlistan

- **Lobbyn visar ingen officiell server:** adressen saknas i `src/config.js` (del 2, steg 4).
- **"Svarar inte" vid den officiella servern:** öppna `…/health`. Svarar den inte har
  dagens kvot kanske tagit slut (se `requestsToday`). Den kommer tillbaka vid midnatt UTC.
  Kommer servern från en annan adress än Netlify-sidan måste den finnas i variabeln
  `ALLOWED_ORIGINS`.
- **"Ingen server har koden …":** värden har inte startat `npm run share` sedan serverlistan
  lades upp, eller så är koden felskriven. Koder har sex tecken och aldrig 0, O, 1 eller I.
- **`npm run share` skriver "Serverlistan svarade inte":** del 1 är inte gjord än
  (`supabase db push` och `supabase functions deploy`). Länken som skrivs ut fungerar ändå.

### Server och inloggning

- **"Inloggningen misslyckades: Wrong issuer":** `SUPABASE_URL` i
  `server/.env` stämmer inte med projektets adress. Den ska inte sluta med `/`.
- **Inloggningen fastnar efter Google eller Discord:** adressen
  `.../?mp=auth` saknas under Redirect URLs i Supabase.
- **"Servern svarar inte" i lobbyn (egen Linux-server):** kontrollera `/health`, öppna
  portar (alternativ 1) och att `ALLOWED_ORIGINS` innehåller sidans adress exakt, med
  `https://`.
- **Oracle har stängt servern:** starta den igen i konsolen och uppgradera till
  Pay As You Go (se steg 2).
- **Supabase-projektet är pausat:** återställ det i Supabases konsol. Den officiella
  servern skickar en förfrågan till Supabase en gång per dygn (och en egen Linux-server två
  gånger per dygn) för att undvika det.
