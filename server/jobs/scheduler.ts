/**
 * Jobs shared by both runtimes. Bun runs them on timers (startScheduler); the Worker runs them from
 * Cron Triggers (see worker/index.ts). Each job is bounded so it fits a 15-minute cron invocation.
 */
import type { SqlDb } from "../db/adapter.ts";
import { nowIso } from "../db/index.ts";
import { refreshCardmarketFromNetwork } from "../ingest/cardmarket.ts";
import { completeCardDetails, refreshTcgdexFromNetwork } from "../ingest/tcgdex.ts";
import { matchCardsToCardmarket } from "../ingest/matcher.ts";
import { ebayConfigured, runEbayIngest } from "../ingest/ebay.ts";
import { recomputeFactors } from "../pricing/engine.ts";
import { snapshotAllPortfolios } from "../services/portfolio.ts";

export type JobName = "daily_refresh" | "guide_refresh" | "catalog_refresh" | "catalog_completion" | "ebay_refresh" | "factors" | "snapshots";
export const JOB_NAMES: JobName[] = ["daily_refresh", "guide_refresh", "catalog_refresh", "catalog_completion", "ebay_refresh", "factors", "snapshots"];

const running = new Set<JobName>();
type Log = (m: string) => void;

export async function runJob(db: SqlDb, job: JobName, log: Log = console.log): Promise<string> {
  if (running.has(job)) return "already running";
  running.add(job);
  const id = (await db.run("INSERT INTO job_runs(job, started_at, status) VALUES (?, ?, 'running')", [job, nowIso()])).lastInsertRowid;
  try {
    const detail = await jobs[job](db, log);
    await db.run("UPDATE job_runs SET finished_at = ?, status = 'ok', detail = ? WHERE id = ?", [nowIso(), detail.slice(0, 4000), id]);
    log(`[job ${job}] ok ${detail}`);
    return detail;
  } catch (e) {
    const msg = (e as Error).message;
    await db.run("UPDATE job_runs SET finished_at = ?, status = 'error', detail = ? WHERE id = ?", [nowIso(), msg.slice(0, 4000), id]).catch(() => {});
    log(`[job ${job}] FEHLER ${msg}`);
    return `error: ${msg}`;
  } finally {
    running.delete(job);
  }
}

const jobs: Record<JobName, (db: SqlDb, log: Log) => Promise<string>> = {
  /** Nightly: new price guide (only linked products), products catalogue on Mondays, eBay, factors, snapshots. */
  async daily_refresh(db, log) {
    const weekday = new Date().getUTCDay();
    const cm = await refreshCardmarketFromNetwork(db, { products: weekday === 1, guideOnlyLinked: true });
    log(`[daily] cardmarket ${JSON.stringify(cm)}`);
    const m = await matchCardsToCardmarket(db);
    if (ebayConfigured()) log(`[daily] ebay ${JSON.stringify(await runEbayIngest(db, undefined, log))}`);
    const f = await recomputeFactors(db);
    const snaps = await snapshotAllPortfolios(db);
    return JSON.stringify({ cardmarket: cm, match: m, factors: f, snapshots: snaps });
  },
  async guide_refresh(db) { return JSON.stringify(await refreshCardmarketFromNetwork(db, { products: false })); },
  /** Weekly: pull set/card lists from TCGdex (new sets, new cards), then match. */
  async catalog_refresh(db, log) {
    const tx = await refreshTcgdexFromNetwork(db, log);
    const m = await matchCardsToCardmarket(db);
    return JSON.stringify({ tcgdex: tx, match: m });
  },
  /** Full details for brief-only cards (bounded batch), then their guide rows. */
  async catalog_completion(db) {
    const pending = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE detail_loaded = 0"))!.n;
    if (!pending) return "complete";
    const r = await completeCardDetails(db);
    const m = await matchCardsToCardmarket(db);
    const guide = await refreshCardmarketFromNetwork(db, { products: false, guideOnlyLinked: true }).catch((e) => ({ error: (e as Error).message }));
    return JSON.stringify({ ...r, matched: m.direct + m.byName, guide });
  },
  async ebay_refresh(db, log) {
    const r = await runEbayIngest(db, undefined, log);
    await recomputeFactors(db);
    return JSON.stringify(r);
  },
  async factors(db) { return JSON.stringify(await recomputeFactors(db)); },
  async snapshots(db) { return JSON.stringify({ snapshots: await snapshotAllPortfolios(db) }); },
};

/** Bun-only timer loop (the Worker uses Cron Triggers instead). */
export function startScheduler(db: SqlDb, dailyHourUtc: number, log: Log = console.log) {
  const tick = async () => {
    const now = new Date();
    const last = (await db.first<{ v: string | null }>("SELECT MAX(started_at) v FROM job_runs WHERE job = 'daily_refresh' AND status = 'ok'"))?.v;
    if (now.getUTCHours() >= dailyHourUtc && (last ? last.slice(0, 10) : null) !== now.toISOString().slice(0, 10)) await runJob(db, "daily_refresh", log);
  };
  setInterval(tick, 5 * 60_000); setTimeout(tick, 15_000);
  const complete = async () => { if ((await db.first<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE detail_loaded = 0"))!.n > 0) await runJob(db, "catalog_completion", log); };
  setInterval(complete, 10 * 60_000); setTimeout(complete, 60_000);
  if (ebayConfigured()) setInterval(() => runJob(db, "ebay_refresh", log), 6 * 3_600_000);
}
