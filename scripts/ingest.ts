#!/usr/bin/env bun
/**
 * Full data refresh (Bun / local).
 *   bun run scripts/ingest.ts                       → import raw files in data/raw, match, reprice
 *   bun run scripts/ingest.ts --fetch               → download Cardmarket + TCGdex into data/raw first (needs internet)
 *   bun run scripts/ingest.ts --fetch --details=all → also fetch full details for every set (slow, ~20k requests)
 *   bun run scripts/ingest.ts --only-linked         → store guide rows only for products linked to cards (D1-style)
 */
import { config } from "../server/config.ts";
import { useDb } from "../server/db/index.ts";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { fetchRawToDisk, importCardmarketFromDisk, importTcgdexFromDisk } from "../server/ingest/local-files.ts";
import { matchCardsToCardmarket } from "../server/ingest/matcher.ts";
import { recomputeFactors } from "../server/pricing/engine.ts";
import { snapshotAllPortfolios } from "../server/services/portfolio.ts";
import { catalogStats } from "../server/services/catalog.ts";

const args = new Set(process.argv.slice(2));
const detailsArg = process.argv.find((a: string) => a.startsWith("--details="))?.split("=")[1];
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const t0 = performance.now();
if (args.has("--fetch")) { log("Lade Rohdaten …"); await fetchRawToDisk(config.rawDir, log, detailsArg === "all" ? "all" : detailsArg === "none" ? "none" : undefined); }
const db = await openBunDb(config.dbPath);
useDb(db);
log("Importiere TCGdex …"); log(JSON.stringify(await importTcgdexFromDisk(db)));
log("Importiere Cardmarket …"); log(JSON.stringify(await importCardmarketFromDisk(db, config.rawDir, args.has("--only-linked"))));
log("Verknüpfe Karten mit Cardmarket-Produkten …"); log(JSON.stringify(await matchCardsToCardmarket(db)));
log("Sprachfaktoren …"); log(JSON.stringify(await recomputeFactors(db)));
log(`Portfolio-Snapshots: ${await snapshotAllPortfolios(db)}`);
log(JSON.stringify(await catalogStats(db)));
log(`Fertig in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
