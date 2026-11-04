# Roadmap & Entscheidungen

## Was jetzt steht (v0.1)

- Katalog: 155 Sets, ~20 000 Karten, deutsche + englische Namen, Bilder, Seltenheit, Varianten (TCGdex).
- Preise: Cardmarket-Preisguide täglich (alle 80 000 Produkte), exakte Zuordnung über TCGdex-Produkt-IDs, Name-Fallback pro Expansion.
- Preismodell mit Sprachfaktor, Verkaufs-Gewichtung, Konfidenz, Spanne, Trend, Historie (wächst täglich).
- eBay.de-Adapter (Browse + Marketplace Insights) inkl. Titel-Klassifikator für Sprache/Grading/Lots – aktiv, sobald Keys hinterlegt sind.
- Community-Verkaufsmeldungen, Watchlist, Portfolio (Wert, Einstand, G/V, Aufteilung, Insights, Snapshots), Set-Fortschritt, Markt-Mover.
- Konten, Sessions, Tarife (Free/Sammler/Pro) mit Stripe Checkout + Webhook, CSV-Export, PWA, Hell/Dunkel.

## Die nächsten 30 Tage (Reihenfolge nach Hebel)

1. **eBay-Keys anlegen** (developer.ebay.com, kostenlos, 15 Min). Danach `EBAY_CLIENT_ID/SECRET` setzen → sofort aktive deutsche Angebote als Preisboden. Parallel „Application Growth Check“/Marketplace-Insights-Zugang beantragen (Begründung: Preisindex für deutschsprachige Sammelkarten).
2. **Katalog komplettieren**: `TCGDEX_DETAIL_SETS=*` einmal laufen lassen (Server macht es sonst im Hintergrund, 600 Karten alle 10 Min).
3. **Preishistorie sammeln lassen**: Ab Tag 1 wird der Guide täglich gespeichert; nach 30 Tagen basieren Trends auf eigener Historie statt Cardmarkts Durchschnitten.
4. **Stripe** anlegen (Produkte Sammler 4,99 €, Pro 9,99 €), Webhook auf `/api/billing/webhook` (Events `customer.subscription.*`).
5. **Domain + Hetzner** nach `deploy/`. Impressum/Datenschutz-Seiten (Pflicht in DE) als statische Views ergänzen.
6. Beta mit 20–30 Sammlern aus deinem Umfeld; Feedback-Schleife über „Verkauf melden“ + Watchlist.

## Danach

- **Kartenscanner**: Foto → Karte (Kandidaten per Set-Symbol + Nummer-OCR; der alte Cropper aus Kartenarchiv passt hier rein).
- **Preisalarme** (E-Mail über Resend/Postmark, Web-Push) auf Basis der Watchlist – Schema ist vorbereitet.
- **Mehrere Sammlungen / Binder / Verkaufslisten**, Freigabe-Links.
- **Graded-Preise**: sobald eBay-Verkäufe mit PSA/BGS-Erkennung laufen, eigene Quotes pro Note statt Multiplikator-Tabelle.
- **Cardmarket-Angebote (deutsch)** als weiterer Boden – nur über offizielle Wege (Partnerprogramm/Widgets), kein Scraping.
- **Händler-API / Export** (Pro+), **Postgres** wenn > ~50 000 aktive Nutzer.
- **Englische Oberfläche** (i18n-Hooks: alle Texte liegen in den Views, Umstellung auf ein Wörterbuch ist mechanisch).

## Bewusste Entscheidungen

- *Keine Abhängigkeiten*: Bun bringt Runtime, SQLite, Bundler, Tests, Argon2 mit. Weniger Angriffsfläche, schnellere Starts, nichts zu patchen.
- *SQLite statt Postgres*: eine Datei, WAL-Modus, Millionen Zeilen ohne Probleme. Schema ist Postgres-portabel.
- *Kein Scraping*: Cardmarket-Downloads und eBay-APIs sind offiziell. Das ist auch die Antwort auf die Frage „warum machen das die anderen nicht?“ – sie dürfen nicht mal eben die deutschen Angebote scrapen; wir bauen die Datenbasis legal und kumulativ auf.
- *Ehrlichkeit vor Scheinpräzision*: Konfidenz und Methode sind immer sichtbar. Das ist das Vertrauensargument gegenüber Collectr.
- *Marke*: „Sammlerwert“ statt „Poke…“ – kein Markenrisiko, funktioniert auch für Yu-Gi-Oh!/One Piece später (Cardmarket-Game-ID ist konfigurierbar).
