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

export interface BackfillStats { from: string; to: string; days: number; missing: number; rows: number; done: boolean; ms: number }

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
  const stats: BackfillStats = { from: date, to: date, days: 0, missing: 0, rows: 0, done: false, ms: 0 };
  if (date > end) { stats.done = true; stats.ms = Date.now() - t0; return stats; }
  const bin = await sevenZip();
  const series = new Map<string, string>(); // cardId|variant → packed points (ascending, this run only)

  while (date <= end && Date.now() - t0 < budget) {
    const dir = mkdtempSync(join(tmpdir(), "tcgcsv-"));
    try {
      const res = await fetch(`${TCGCSV_BASE}/archive/tcgplayer/prices-${date}.ppmd.7z`, { headers: { "user-agent": config.ingest.userAgent }, signal: AbortSignal.timeout(120_000) });
      if (res.status === 404) { stats.missing++; }
      else if (!res.ok) { log(`Archiv ${date}: HTTP ${res.status} – später erneut`); break; }
      else {
        const archive = join(dir, "a.7z");
        writeFileSync(archive, new Uint8Array(await res.arrayBuffer()));
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
    stats.to = date; stats.days++;
    date = nextDay(date);
    if (stats.days % 25 === 0) log(`Backfill: ${stats.days} Tage bis ${stats.to}, ${series.size} Serien im Speicher, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await sleep(150);
  }

  stats.rows = await flush(db, series);
  await db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [CURSOR_KEY, date]);
  stats.done = date > end;
  stats.ms = Date.now() - t0;
  return stats;
}

/** Merge the run's points into existing rows (read → merge → replace); statements grouped under D1's 100 KB query limit. */
async function flush(db: SqlDb, series: Map<string, string>): Promise<number> {
  if (!series.size) return 0;
  const byCard = new Map<string, string[]>();
  for (const k of series.keys()) { const id = k.slice(0, k.indexOf("|")); (byCard.get(id) ?? byCard.set(id, []).get(id)!).push(k); }
  const now = new Date().toISOString();
  let written = 0;
  for (const ids of chunks([...byCard.keys()], 90)) {
    const existing = new Map<string, string>();
    for (const r of await db.all<{ card_id: string; variant: string; points: string }>(`SELECT card_id, variant, points FROM price_series WHERE source = 'tcgplayer' AND card_id IN (${placeholders(ids.length)})`, ids)) existing.set(`${r.card_id}|${r.variant}`, r.points);
    const group: Statement[] = []; let size = 0;
    const send = async () => { if (group.length) { await db.batch(group.splice(0)); } size = 0; };
    for (const id of ids) for (const k of byCard.get(id)!) {
      const merged = mergePacked(existing.get(k), series.get(k));
      const pts = parsePacked(merged);
      if (!pts.length) continue;
      const variant = k.slice(k.indexOf("|") + 1);
      const s = stmt("INSERT OR REPLACE INTO price_series(card_id, source, variant, currency, points, first_date, last_date, n, updated_at) VALUES (?, 'tcgplayer', ?, 'USD', ?, ?, ?, ?, ?)", id, variant, merged, pts[0]![0], pts[pts.length - 1]![0], pts.length, now);
      if (size + merged.length > 85_000) await send();
      group.push(s); size += merged.length + 200; written++;
    }
    await send();
  }
  return written;
}
