# Så sätter du upp multiplayer

Den här guiden tar dig från noll till en server som du och dina vänner kan
spela på, utan månadskostnad. Den tar ungefär en timme första gången.

Det här behöver du:

| Del | Tjänst | Kostnad |
|---|---|---|
| Spelservern, som också levererar själva spelet | Oracle Cloud Always Free (en ARM-server i Stockholm) | 0 kr |
| En adress med HTTPS | DuckDNS och Caddy, eller en egen domän via Cloudflare | 0 kr, eller cirka 100 kr/år med egen domän |
| Inloggning med e-post, Google och Discord | Supabase (gratisnivån) | 0 kr |

Du kan prova allt på din egen dator först, se steg 0.

---

## Steg 0: prova lokalt (5 minuter)

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

## Steg 1: Supabase (inloggningen)

1. Skapa ett konto på <https://supabase.com> och skapa ett nytt projekt (**New
   project**). Välj den region som ligger närmast, helst i Norden eller annars
   Frankfurt. Lösenordet till databasen behövs inte för spelet.
2. Gå till **Authentication → URL Configuration**:
   - **Site URL:** adressen där spelet kommer att ligga, till exempel
     `https://pixelgame.duckdns.org`.
   - **Redirect URLs:** lägg till `https://pixelgame.duckdns.org/?mp=auth` och,
     för lokala tester, `http://localhost:8787/?mp=auth`.
3. Gå till **Authentication → Sign In / Providers**:
   - **Email** är påslaget från början.
   - **Discord:** skapa en app på <https://discord.com/developers/applications>.
     Under OAuth2 lägger du till Redirect URI
     `https://<ditt-projekt>.supabase.co/auth/v1/callback`. Kopiera sedan Client ID
     och Client Secret till Supabase.
   - **Google:** skapa en *OAuth client ID* av typen *Web application* i
     <https://console.cloud.google.com/apis/credentials>, med samma Redirect URI
     som för Discord. Kopiera Client ID och Client Secret till Supabase.
4. Gå till **Authentication → Emails → Magic Link** och lägg till en rad i mallen:
   `Din kod: {{ .Token }}`.
   Då innehåller mejlet en sexsiffrig kod som spelaren kan skriva in. Det behövs
   på mobiler där spelet är installerat som app, eftersom länken i mejlet då
   öppnas i webbläsaren i stället för i appen.
5. Gå till **Project Settings → API** och spara:
   - **Project URL**, till exempel `https://abcd.supabase.co`;
   - **anon/publishable key**. Den är tänkt att vara offentlig och får ligga i
     spelet.

Om ditt projekt är äldre och använder en delad *JWT Secret* behöver servern
den också (`SUPABASE_JWT_SECRET`). Nya projekt signerar med publika nycklar, och
då hämtar servern dem själv.

---

## Steg 2: Oracle Cloud (servern)

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

## Steg 3: installera spelet på servern

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

### Alternativ A, 0 kr: DuckDNS och Caddy

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

### Alternativ B, egen domän: Cloudflare Tunnel

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

## Steg 4: fyll i inställningarna i spelet

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

### Valfritt: spelet på Cloudflare Pages

Om du vill att spelet laddas från Cloudflares CDN i stället:

1. Koppla repot under **Workers & Pages → Create → Pages**.
2. Ställ in **Build command** `npm run dist`, **Output** `dist` och miljövariabeln
   `NODE_VERSION=22`.
3. Lägg till servern i `mp.servers`:
   `{ name: 'Vår server', url: 'wss://pixelgame.duckdns.org/ws' }`.
4. Lägg till `https://<projekt>.pages.dev` i `ALLOWED_ORIGINS` och i Supabases
   Redirect URLs (med `/?mp=auth` på slutet).

---

## Steg 5: spela

1. Öppna spelet, tryck på **Multiplayer**, logga in och tryck på **Spela**.
2. Välj ditt namn. Det går inte att byta senare.
3. Öppna **Klan** (B, eller via menyn), grunda en klan och bjud in dina vänner
   med deras spelarnamn.
4. Gå ut i vildmarken, minst 40 rutor från Fristaden, tryck på **Bygg** (G) och
   res klanbanéret. Sedan kan ni bygga murar, grindar och torn inom marken.

---

## Drift

| Vad | Hur |
|---|---|
| Se loggen | `docker compose logs -f game` |
| Uppdatera | `git pull && docker compose --profile caddy up -d --build`. Servern sparar allt innan den startar om |
| Backup | Servern sparar en kopia av databasen varje natt i `server-data/backups` och behåller 14 dagar. För att kopiera dem till en annan plats: installera rclone, kör `rclone config` och skapa till exempel en R2-, Google Drive- eller Oracle-remote som heter `backup`. Lägg sedan in `deploy/backup-offsite.sh` i crontab |
| Återställa | Stoppa servern och kopiera en backup till `server-data/pixelgame.db` |
| Övervakning | Lägg in `https://din-adress/health` hos <https://uptimerobot.com> (gratis). Då får du ett mejl om servern går ner |
| Admin i spelet | Skriv i chatten (T): `/kick namn`, `/ban namn timmar orsak`, `/unban namn`, `/tp x y`, `/give scrap 100`, `/announce text`, `/save` |
| Raidvarningar till Discord | Sätt `DISCORD_WEBHOOK_URL` i `server/.env` |
| Utan Docker | `deploy/pixelgame.service` är en systemd-tjänst. Den behöver Node 22 och `npm ci --omit=dev` |

## Felsökning

- **"Inloggningen misslyckades: Wrong issuer":** `SUPABASE_URL` i
  `server/.env` stämmer inte med projektets adress. Den ska inte sluta med `/`.
- **Inloggningen fastnar efter Google eller Discord:** adressen
  `.../?mp=auth` saknas under Redirect URLs i Supabase.
- **"Servern svarar inte" i lobbyn:** kontrollera `/health`, öppna portar (alternativ
  A) och att `ALLOWED_ORIGINS` innehåller sidans adress exakt, med `https://`.
- **Oracle har stängt servern:** starta den igen i konsolen och uppgradera till
  Pay As You Go (se steg 2).
- **Supabase-projektet är pausat:** återställ det i Supabases konsol. Servern
  skickar en förfrågan till Supabase två gånger per dygn för att undvika det.
