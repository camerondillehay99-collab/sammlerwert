# Sammlerwert auf Cloudflare – kostenlos

**Architektur (Free-Plan-tauglich)**

| Teil | Dienst | Kosten |
| --- | --- | --- |
| App-Server (API, Auth, Portfolio) | Cloudflare Workers – 100 000 Requests/Tag | 0 € |
| Datenbank | Cloudflare D1 `sammlerwert` (Western Europe) – 5 Mio. gelesene / 100 000 geschriebene Zeilen pro Tag, 5 GB | 0 € |
| Frontend | Workers Static Assets (unbegrenzt, gecacht am Edge) | 0 € |
| Nächtliche Datenjobs (Cardmarket, TCGdex, eBay, Sprachfaktoren) | GitHub Actions – 2 000 Min./Monat im privaten Repo, Job braucht ~5 Min./Nacht | 0 € |
| Bilder-Uploads (optional) | R2 – 10 GB frei | 0 € |

Der Trick: **Preise werden beim Lesen berechnet** (`server/pricing/quotes.ts`) statt nachts für 20 000 Karten gespeichert. Die einzigen täglichen Schreibvorgänge sind die Preisguide-Zeilen der verknüpften Produkte (~2 pro Karte) und ein paar Sprachfaktoren – weit unter dem Limit. Alles Rechenintensive (15-MB-JSON parsen, 20 000 Kartendetails holen) läuft im GitHub-Actions-Job, nicht im Worker (10 ms CPU im Free-Plan).

## 1 · Erst-Deployment (einmalig, ~5 Minuten)
Doppelklick `deploy\cloudflare-first-deploy.cmd`: Cloudflare-Login, zeigt deine **Account-ID**, lädt den Katalog in D1 (Seed Teil 1, ~41 000 Zeilen), deployt den Worker. Danach ist die Seite unter `https://sammlerwert.<subdomain>.workers.dev` erreichbar – Suche und Preise erscheinen mit dem ersten nächtlichen Job (Schritt 2) oder morgen über `cloudflare-seed-part2.cmd`.

## 2 · GitHub einrichten (einmalig, ~10 Minuten) – das macht das Projekt „selbstlaufend“
1. Privates Repo anlegen (z. B. `sammlerwert`), Projekt pushen (`git init && git add . && git commit -m "init" && git branch -M main && git remote add origin … && git push -u origin main`).
2. Cloudflare → *My Profile → API Tokens → Create Token → „Edit Cloudflare Workers“-Vorlage*, zusätzlich Berechtigung **D1 → Edit** hinzufügen. Token kopieren.
3. GitHub → Repo → *Settings → Secrets and variables → Actions*:
   * Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (aus Schritt 1), optional `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`
   * Variables (optional): `DETAIL_BATCH` (Standard 2500 Kartendetails/Nacht), `EBAY_INSIGHTS_ENABLED`
4. *Actions → Nightly data refresh → Run workflow* einmal manuell starten → baut Suchindex + lädt Preise. Ab dann täglich 04:15 UTC automatisch.

Ab jetzt deployt **jeder Push auf `main`** automatisch (`.github/workflows/deploy.yml`: Tests → Build → `wrangler deploy`). Lokal geht weiterhin `deploy\cloudflare-redeploy.cmd`.

## Schreibbudget (D1 Free: 100 000 Zeilen/Tag inkl. Index-Zeilen)
| Vorgang | Zeilen |
| --- | --- |
| Seed Teil 1 (Deploy-Tag) | ~41 000 |
| Erste Nacht: Suchindex + Preisguide | ~20 000 + ~17 000 |
| Danach pro Nacht: Preisguide (bei vollständigem Katalog ~20 000 Karten) + 2 500 Kartendetails + Faktoren | ~45 000 + 5 000 + <1 000 |
| Nutzer: Karte hinzufügen / Verkauf melden / Snapshot | 1–3 pro Aktion |

Der Nightly-Job protokolliert `rowsWritten` pro Lauf (Actions-Log und Tabelle `job_runs`). Wenn das Projekt wächst (Tausende aktive Nutzer), ist der Wechsel auf Workers Paid ($5/Monat) ein Klick – keine Code-Änderung.

## Secrets im Worker (Stripe)
`deploy\cloudflare-secrets.cmd` oder `npx wrangler secret put STRIPE_SECRET_KEY` usw. Webhook-URL: `https://<url>/api/billing/webhook`, Events `customer.subscription.*`. `PUBLIC_URL` in `wrangler.toml` auf die echte URL setzen.

## R2 für Bilder (optional)
Dashboard → R2 → aktivieren → Bucket `sammlerwert-uploads` → `[[r2_buckets]]`-Block in `wrangler.toml` einkommentieren → redeploy.

## Eigene Domain
Worker → Settings → Domains & Routes → Custom Domain (z. B. `app.sammlerwert.de`). HTTPS automatisch, kostenlos.

## Lokal entwickeln
Wie gehabt: `bun run build:web && bun run start` (SQLite). Gleicher Code, anderer Datenbank-Adapter.
