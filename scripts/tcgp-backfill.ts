/**
 * One-off (resumable) TCGplayer history backfill from TCGCSV's daily archives, 2024-02-08 → yesterday.
 * Runs inside the nightly GitHub Actions job (STEPS contains "tcgp_backfill"), time-budgeted: it processes as many
 * days as fit, writes them, stores a cursor in meta and continues on the next run until it catches up.
 *   archive: https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z  →  YYYY-MM-DD/3/{groupId}/prices
 * Bun-only (7z child process + temp files); everything reusable lives in server/ingest/tcgplayer.ts.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlDb, Statement } from "../server/db/adapter.ts";
import { chunks, placeholders, stmt } from "../server/db/adapter.ts";
import { config } from "../server/config.ts";
import { sleep } from "../server/ingest/http.ts";
import { TCGCSV_BASE, TCGCSV_FIRST_ARCHIVE, TCGP_CATEGORY, ensureTcgpTables, matchCardsToTcgplayer, matchedGroupIds, pointsFromPrices, priceDateFor, productIndex, toPrice } from "../server/ingest/tcgplayer.ts";
import { mergePacked, packedPoint, parsePacked } from "../server/pricing/history.ts";

const CURSOR_KEY = "tcgp_backfill_cursor";
const nextDay = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);

const which = (name: string) => { const r = spawnSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
async function sevenZip(): Promise<string> {
  for (const name of ["7z", "7zz", "7za"]) { const p = which(name); if (p) return p; }
  spawnSync("bash", ["-lc", "sudo apt-get update -qq && sudo apt-get install -y -qq p7zip-full"], { stdio: ["ignore", "ignore", "inherit"] });
  const p = which("7z");
  if (!p) throw new Error("7z nicht verfügbar – Archiv-Backfill nicht möglich.");
  return p;
}

function extract(bin: string, archive: string, dir: string, date: string): string | null {
  const want = join(dir, date, String(TCGP_CATEGORY));
  spawnSync(bin, ["x", "-y", `-o${dir}`, archive, `${date}/${TCGP_CATEGORY}/*`, "-r"], { stdio: "ignore" });
  if (existsSync(want)) return want;
  spawnSync(bin, ["x", "-y", `-o${dir}`, archive], { stdio: "ignore" });
  return existsSync(want) ? want : null;
}

export interface BackfillStats { from: string; to: string; days: number; missing: number; rows: number; flushes: number; done: boolean; ms: number }

/** Days downloaded between two writes; keeps every run's progress durable (cursor is saved after each flush). */
const CHUNK_DAYS = Math.max(10, Number(process.env.BACKFILL_CHUNK_DAYS ?? "0") || 120);
const PACE_MS = Math.max(150, Number(process.env.BACKFILL_PACE_MS ?? "0") || 600);

async function download(date: string): Promise<{ status: "ok"; data: ArrayBuffer } | { status: "missing" } | { status: "stop"; why: string }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${TCGCSV_BASE}/archive/tcgplayer/prices-${date}.ppmd.7z`, { headers: { "user-agent": config.ingest.userAgent }, signal: AbortSignal.timeout(120_000) });
    } catch (e) { if (attempt === 5) return { status: "stop", why: `Netzwerk: ${(e as Error).message}` }; await sleep(5_000 * (attempt + 1)); continue; }
    if (res.status === 404) return { status: "missing" };
    if (res.ok) return { status: "ok", data: await res.arrayBuffer() };
    if (res.status === 429 || res.status >= 500) {
      // Rate-limited (tcgcsv asks for gentle pacing): honour Retry-After, otherwise back off 30 s → 4 min.
      const retry = Number(res.headers.get("retry-after") ?? "0");
      const wait = Math.min(300_000, Math.max(30_000, retry > 0 ? retry * 1000 : 30_000 * 2 ** attempt));
      await res.arrayBuffer().catch(() => undefined);
      await sleep(wait);
      continue;
    }
    return { status: "stop", why: `HTTP ${res.status}` };
  }
  return { status: "stop", why: "HTTP 429 – Ratenlimit hält an" };
}

export async function runTcgpBackfill(db: SqlDb, opts: { budgetMs?: number; from?: string; to?: string } = {}, log: (m: string) => void = () => {}): Promise<BackfillStats> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 35 * 60_000;
  await ensureTcgpTables(db);
  let index = await productIndex(db);
  if (!index.size) { log(`TCGplayer-Zuordnung fehlt – wird aufgebaut: ${JSON.stringify(await matchCardsToTcgplayer(db, log))}`); index = await productIndex(db); }
  const groupIds = await matchedGroupIds(db);
  const cursor = (await db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [CURSOR_KEY]))?.value;
  let date = opts.from ?? cursor ?? TCGCSV_FIRST_ARCHIVE;
  const end = opts.to ?? priceDateFor();
  const stats: BackfillStats = { from: date, to: date, days: 0, missing: 0, rows: 0, flushes: 0, done: false, ms: 0 };
  if (date > end) { stats.done = true; stats.ms = Date.now() - t0; return stats; }
  let bin: string | null = null; // resolved lazily – missing days need no extractor
  const saveCursor = () => db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [CURSOR_KEY, date]);

  let lastChunkMs = 0, stop: string | null = null;
  while (date <= end && !stop) {
    // Only start another chunk when the previous one (download + flush) would fit into what is left of the budget.
    const left = budget - (Date.now() - t0);
    if (stats.flushes > 0 && left < lastChunkMs * 1.25 + 30_000) break;
    const tc = Date.now();
    const series = new Map<string, string>(); // cardId|variant → packed points (ascending, this chunk only)
    let days = 0;
    while (date <= end && days < CHUNK_DAYS && Date.now() - t0 < budget) {
      const dir = mkdtempSync(join(tmpdir(), "tcgcsv-"));
      try {
        const got = await download(date);
        if (got.status === "stop") { stop = `Archiv ${date}: ${got.why} – später erneut`; break; }
        if (got.status === "missing") stats.missing++;
        else {
          const archive = join(dir, "a.7z");
          writeFileSync(archive, new Uint8Array(got.data));
          bin ??= await sevenZip();
          const root = extract(bin, archive, dir, date);
          if (!root) { stats.missing++; log(`Archiv ${date}: kein Pokémon-Verzeichnis`); }
          else {
            for (const gid of groupIds) {
              const f = join(root, String(gid), "prices");
              if (!existsSync(f)) continue;
              let raw: unknown;
              try { raw = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
              const list = Array.isArray(raw) ? raw : ((raw as { results?: unknown[] })?.results ?? []);
              for (const p of pointsFromPrices((list as Record<string, unknown>[]).map(toPrice), index)) {
                const k = `${p.cardId}|${p.variant}`, pt = packedPoint(date, p.price);
                const cur = series.get(k);
                series.set(k, cur ? `${cur};${pt}` : pt);
              }
            }
          }
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
      stats.to = date; stats.days++; days++;
      date = nextDay(date);
      await sleep(PACE_MS);
    }
    if (days === 0) break;
    const tf = Date.now();
    stats.rows += await flush(db, series);
    stats.flushes++;
    await saveCursor();
    lastChunkMs = Date.now() - tc;
    log(`Backfill: ${days} Tage bis ${stats.to} geschrieben (${series.size} Serien, Download ${((tf - tc) / 1000).toFixed(0)} s, Schreiben ${((Date.now() - tf) / 1000).toFixed(0)} s), Cursor ${date}`);
  }
  if (stop) log(stop);
  stats.done = date > end;
  stats.ms = Date.now() - t0;
  return stats;
}

/** Merge the chunk's points into existing rows (read → merge → replace); statements grouped under D1's 100 KB query
 *  limit and sent with a few requests in flight, since HTTP latency – not D1 – dominates. */
const FLUSH_PARALLEL = 4;
export async function flush(db: SqlDb, series: Map<string, string>): Promise<number> {
  if (!series.size) return 0;
  const byCard = new Map<string, string[]>();
  for (const k of series.keys()) { const id = k.slice(0, k.indexOf("|")); (byCard.get(id) ?? byCard.set(id, []).get(id)!).push(k); }
  const now = new Date().toISOString();
  let written = 0;
  for (const ids of chunks([...byCard.keys()], 60)) {
    const existing = new Map<string, string>();
    for (const r of await db.all<{ card_id: string; variant: string; points: string }>(`SELECT card_id, variant, points FROM price_series WHERE source = 'tcgplayer' AND card_id IN (${placeholders(ids.length)})`, ids)) existing.set(`${r.card_id}|${r.variant}`, r.points);
    const groups: Statement[][] = [];
    let group: Statement[] = [], size = 0;
    for (const id of ids) for (const k of byCard.get(id)!) {
      const merged = mergePacked(existing.get(k), series.get(k));
      const pts = parsePacked(merged);
      if (!pts.length) continue;
      const variant = k.slice(k.indexOf("|") + 1);
      if (size + merged.length > 85_000) { groups.push(group); group = []; size = 0; }
      group.push(stmt("INSERT OR REPLACE INTO price_series(card_id, source, variant, currency, points, first_date, last_date, n, updated_at) VALUES (?, 'tcgplayer', ?, 'USD', ?, ?, ?, ?, ?)", id, variant, merged, pts[0]![0], pts[pts.length - 1]![0], pts.length, now));
      size += merged.length + 200; written++;
    }
    if (group.length) groups.push(group);
    for (let i = 0; i < groups.length; i += FLUSH_PARALLEL) await Promise.all(groups.slice(i, i + FLUSH_PARALLEL).map((g) => db.batch(g)));
  }
  return written;
}
