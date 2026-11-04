# Sammlerwert

**Portfolio, Marktwerte und Verkaufsdaten für deutsche Pokémon-Karten.**
Web-App + installierbare PWA. Deutsch zuerst. Zero-Dependency-Stack (Bun + SQLite), damit es schnell bleibt und du jede Zeile verstehst.

## Warum das hier anders ist

Collectr, Card Ladder & Co. bepreisen deutsche Karten entweder gar nicht oder mit dem gemischten (englisch dominierten) Marktpreis. Sammlerwert berechnet pro Karte, **Sprache** und **Variante** einen eigenen Marktwert:

| Signal | Quelle | Gewicht |
| --- | --- | --- |
| Verkäufe deutscher Karten | eBay.de (Marketplace Insights, sobald freigeschaltet), Community-Meldungen | stärkstes Signal, zeitlich abklingend (Halbwertszeit 21 Tage), zustandsbereinigt, ausreißerfest |
| Aktive deutsche Angebote | eBay.de Browse API | nur als Boden, max. 25 % Einfluss |
| Cardmarket-Preisguide (täglich, alle Sprachen) | öffentlicher Download, als tägliche Snapshots gespeichert (= Preishistorie) | Anker × gelernter **Sprachfaktor pro Set** (Median aus Verkauf ÷ Guide) |

Jeder Wert kommt mit Konfidenz, Spanne, Trend und der Methode, die ihn erzeugt hat. Keine Daten → sagen wir es.

## Schnellstart (lokal)

```bash
# 1) Bun installieren: https://bun.sh (curl -fsSL https://bun.sh/install | bash  bzw.  powershell -c "irm bun.sh/install.ps1 | iex")
cp .env.example .env            # optional anpassen
bun run build:web               # Frontend bündeln (≈ 55 kB JS)
bun run ingest:fetch            # Cardmarket-Guide + TCGdex-Katalog laden, verknüpfen, bepreisen (erster Lauf ~10–20 Min)
bun run start                   # http://localhost:4180
```

Wenn du den Datenordner `data/raw/` schon hast (z. B. aus dem PowerShell-Bootstrap `sammlerwert-fetch-data.ps1`), reicht `bun run ingest` – kein Netz nötig.

Der Server lädt danach **selbstständig** jede Nacht den neuen Preisguide, ergänzt fehlende Kartendetails (TCGdex) im Hintergrund, holt eBay-Daten (falls Keys da sind), berechnet alle Preise neu und schreibt Portfolio-Snapshots. Admin-Konten (`ADMIN_EMAILS`) können alle Jobs unter *Einstellungen → Admin* manuell starten.

## Produktion auf Cloudflare – kostenlos (siehe deploy/CLOUDFLARE.md)

Workers (serve-only) + D1 + Static Assets; die nächtlichen Datenjobs laufen in GitHub Actions. Preise werden beim Lesen berechnet (`server/pricing/quotes.ts`), damit D1s Free-Plan-Schreiblimit reicht. Der Worker (`worker/index.ts`) nutzt denselben Code wie der Bun-Server; `server/db/` hat Adapter für bun:sqlite, D1 (Binding) und D1 (REST, für Actions).

```bash
deploy\cloudflare-first-deploy.cmd   # einmalig: Login, Katalog seeden, deployen
deploy\cloudflare-redeploy.cmd       # danach ~20 s – oder automatisch bei jedem Push auf main
```

## Produktion selbst gehostet (Docker + HTTPS)

```bash
cp .env.example .env && $EDITOR .env           # PUBLIC_URL, ADMIN_EMAILS, Stripe/eBay-Keys
sed -i 's/sammlerwert.de/deine-domain.de/g' deploy/Caddyfile
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec app bun run scripts/ingest.ts --fetch
```

Ein 2-vCPU/4-GB-Server (Hetzner CX22, ~4 €/Monat, Rechenzentrum Falkenstein/Nürnberg → EU-Daten) reicht für die ersten tausend Nutzer. SQLite im WAL-Modus; die Datenbank liegt im Volume `sammlerwert-data`. Backup = Datei kopieren (`sqlite3 sammlerwert.db ".backup backup.db"`).

## Struktur

```
server/            Bun-Server (API, Auth, Jobs)
  db/schema.sql    Schema (Postgres-portabel)
  ingest/          cardmarket.ts · tcgdex.ts · matcher.ts · ebay.ts · listing-classifier.ts
  pricing/         engine.ts (Marktwert-Modell, getestet) · stats.ts
  services/        catalog.ts (Suche/FTS5, Karten, Sets, Mover) · portfolio.ts (Bewertung, Insights, Snapshots)
  billing/         stripe.ts (Checkout, Portal, Webhook – ohne SDK)
  api/routes.ts    REST-API
shared/types.ts    gemeinsame Typen
web/src            SPA ohne Framework (Router, Views, SVG-Charts), web/styles/app.css Design-System
scripts/           ingest.ts · build-web.ts · reprice.ts · make-admin.ts
tests/             bun test (Engine, Klassifikator, Parser, API)
deploy/            Dockerfile · docker-compose.yml · Caddyfile
```

## API (Auszug)

`GET /api/search?q=glurak&set=sv03.5&sort=value` · `GET /api/cards/:id` · `GET /api/sets` · `GET /api/sets/:id` · `GET /api/market/movers?lang=de`
`POST /api/auth/register|login|logout` · `GET /api/portfolio` · `GET|POST /api/items` · `PATCH|DELETE /api/items/:id` · `POST /api/items/:id/image`
`POST /api/cards/:id/sales` (Community-Verkauf) · `GET|POST /api/watchlist` · `GET /api/export.csv` · `POST /api/billing/checkout|portal|webhook` · `POST /api/admin/jobs/:job`

## Datenquellen & Rechtliches

* **Cardmarket** stellt Preisguide und Produktkatalog seit Juni 2024 öffentlich zum Download bereit (API-Zugänge werden nicht mehr vergeben). Täglich ~80 000 Produkte. Preise gelten über alle Sprachen – genau deshalb gibt es den Sprachfaktor.
* **TCGdex** (Open Source, MIT) liefert Katalog, deutsche Namen, Bilder und die Cardmarket-Produkt-IDs. Bilder werden direkt von `assets.tcgdex.net` geladen (nicht gespiegelt). Für vintage Sets fehlen deutsche Scans → englischer Scan mit Hinweis.
* **eBay**: Browse API ist mit jedem Developer-Account nutzbar; die Marketplace-Insights-API (verkaufte Artikel, 90 Tage) ist „Limited Release“ – Antrag über das Developer-Portal. Beide greifen nur über offizielle APIs, kein Scraping.
* Pokémon und alle Kartennamen sind Marken ihrer Rechteinhaber. Sammlerwert ist ein inoffizielles, unabhängiges Werkzeug.

## Tests & Qualität

```bash
bun test            # 38 Tests: Preismodell, Klassifikator, Parser, API, Worker (simuliertes D1), D1-REST-Adapter
```

## Roadmap (siehe ROADMAP.md)

Kartenscanner (Foto → Karte), Preisalarme per E-Mail/Push, mehrere Sammlungen, Set-Vervollständigung, Händler-API, Cardmarket-Angebotsbeobachtung für deutsche Sprache, Postgres-Migration bei Bedarf.
