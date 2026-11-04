#!/usr/bin/env bun
// Recompute language factors + portfolio snapshots (prices themselves are computed on read).
import { config } from "../server/config.ts";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { recomputeFactors } from "../server/pricing/engine.ts";
import { snapshotAllPortfolios } from "../server/services/portfolio.ts";
const db = await openBunDb(config.dbPath);
console.log(JSON.stringify(await recomputeFactors(db)));
console.log(`snapshots: ${await snapshotAllPortfolios(db)}`);
