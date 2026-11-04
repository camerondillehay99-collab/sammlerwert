#!/usr/bin/env bun
/**
 * Nightly data job – runs in GitHub Actions (free) against the production D1 via the REST API.
 * Keeps every step inside D1's free-tier write budget (100 000 rows/day incl. index rows):
 *   1. card details for brief-only cards (bounded, newest sets first)      ≈ 2 × batch
 *   2. Mondays: new sets/cards from TCGdex (only new rows + their FTS rows)  small
 *   3. Cardmarket price guide, only for products linked to cards             ≈ 2 × linked (~20k when complete)
 *   4. eBay.de listings/sales (only with keys)                               small
 *   5. language factors                                                      < 1k
 *   6. bootstrap safety net: rebuild empty FTS, write guide date
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID (optional, read from wrangler.toml), DETAIL_BATCH, EBAY_*
 */
import { D1HttpDb } from "../server/db/d1-http.ts";
import { applyEnv } from "../server/config.ts";
import { completeCardDetails, refreshTcgdexFromNetwork } from "../server/ingest/tcgdex.ts";
import { refreshCardmarketFromNetwork } from "../server/ingest/cardmarket.ts";
import { matchCardsToCardmarket } from "../server/ingest/matcher.ts";
import { ebayConfigured, runEbayIngest } from "../server/ingest/ebay.ts";
import { recomputeFactors } from "../server/pricing/engine.ts";
import { rebuildFts } from "../server/ingest/tcgdex.ts";
import { catalogStats } from "../server/services/catalog.ts";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const env = process.env;
const accountId = env.CLOUDFLARE_ACCOUNT_ID, apiToken = env.CLOUDFLARE_API_TOKEN;
let databaseId = env.D1_DATABASE_ID;
if (!databaseId) databaseId = (await Bun.file("wrangler.toml").text()).match(/database_id\s*=\s*"([^"]+)"/)?.[1];
if (!accountId || !apiToken || !databaseId) { console.error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN und D1_DATABASE_ID (oder wrangler.toml) werden benötigt."); process.exit(1); }

applyEnv({ ...env, INGEST_DELAY_MS: env.INGEST_DELAY_MS ?? "40", CATALOG_COMPLETION_BATCH: env.DETAIL_BATCH ?? "2500" });
const db = new D1HttpDb({ accountId, databaseId, apiToken });
const steps = new Set((env.STEPS ?? "details,catalog,guide,ebay,factors").split(","));
const weekday = new Date().getUTCDay();
const t0 = Date.now();

try {
  // Tables added after the first deploy (schema.sql is the source of truth; these are cheap no-ops once they exist).
  await db.exec(`CREATE TABLE IF NOT EXISTS ebay_refresh (card_id TEXT PRIMARY KEY REFERENCES cards(id), last_at TEXT NOT NULL, listings INTEGER NOT NULL DEFAULT 0, sales INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS deploy_patches (id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, content TEXT, deleted INTEGER NOT NULL DEFAULT 0, message TEXT, created_at TEXT NOT NULL, applied_at TEXT);`);
  log(`Start. Stand: ${JSON.stringify(await catalogStats(db))}`);

  // Bootstrap: right after the first deploy only the catalogue is seeded (write budget). Build the search index first
  // and skip card details this night so FTS + guide stay well under 100k written rows.
  let bootstrapped = false;
  if (!(await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards_fts"))!.n) { log("FTS-Index leer – baue auf …"); await rebuildFts(db); bootstrapped = true; }

  if (steps.has("details") && !bootstrapped) {
    const pending = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE detail_loaded = 0"))!.n;
    log(`Kartendetails ausstehend: ${pending}`);
    if (pending) log(`Details: ${JSON.stringify(await completeCardDetails(db))}`);
  }
  if (steps.has("catalog") && (weekday === 1 || env.FORCE_CATALOG === "1")) {
    log(`Katalog: ${JSON.stringify(await refreshTcgdexFromNetwork(db, log, true))}`);
  }
  if (steps.has("guide")) {
    log(`Preisguide: ${JSON.stringify(await refreshCardmarketFromNetwork(db, { products: false, guideOnlyLinked: true }))}`);
    log(`Zuordnung: ${JSON.stringify(await matchCardsToCardmarket(db))}`);
  }
  if (steps.has("ebay") && ebayConfigured()) log(`eBay: ${JSON.stringify(await runEbayIngest(db, undefined, log))}`);
  if (steps.has("factors")) log(`Sprachfaktoren: ${JSON.stringify(await recomputeFactors(db))}`);

  await db.run("INSERT INTO job_runs(job, started_at, finished_at, status, detail) VALUES ('nightly', ?, ?, 'ok', ?)",
    [new Date(t0).toISOString(), new Date().toISOString(), JSON.stringify(db.stats)]);
  log(`Fertig in ${((Date.now() - t0) / 1000).toFixed(0)} s · D1: ${db.stats.requests} Requests, ${db.stats.rowsWritten} Zeilen geschrieben, ${db.stats.rowsRead} gelesen`);
} catch (e) {
  log(`FEHLER: ${(e as Error).stack ?? e}`);
  await db.run("INSERT INTO job_runs(job, started_at, finished_at, status, detail) VALUES ('nightly', ?, ?, 'error', ?)", [new Date(t0).toISOString(), new Date().toISOString(), String((e as Error).message).slice(0, 2000)]).catch(() => {});
  process.exit(1);
}
