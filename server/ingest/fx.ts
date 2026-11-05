/**
 * USD→EUR reference rates (ECB, via frankfurter.app – free, no key) so TCGplayer's USD history can be shown in EUR
 * at the rate of each day rather than today's. Stored packed in meta (`fx_usd_eur`, ~10 KB for a decade).
 */
import type { SqlDb } from "../db/adapter.ts";
import { memoClear } from "../db/adapter.ts";
import { getJson } from "./http.ts";
import { FX_KEY, mergePacked, packPoints, parsePacked, type Point } from "../pricing/history.ts";

export const FX_BASE = "https://api.frankfurter.app";

interface FxResponse { rates?: Record<string, Record<string, number>> }

export function parseFx(json: FxResponse, quote = "EUR"): Point[] {
  const out: Point[] = [];
  for (const [date, r] of Object.entries(json.rates ?? {})) { const v = r?.[quote]; if (typeof v === "number" && v > 0) out.push([date, Math.round(v * 10_000) / 10_000]); }
  return out;
}

/** Fetch a date range and merge it into meta. Returns how many daily rates we now hold. */
export async function refreshFx(db: SqlDb, from: string, to = new Date().toISOString().slice(0, 10)): Promise<number> {
  const json = await getJson<FxResponse>(`${FX_BASE}/${from}..${to}?from=USD&to=EUR`, { timeoutMs: 60_000 });
  const fresh = packPoints(parseFx(json));
  const existing = (await db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [FX_KEY]))?.value ?? "";
  const merged = mergePacked(existing, fresh);
  await db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FX_KEY, merged]);
  memoClear(db, "fx_usd_eur");
  return parsePacked(merged).length;
}

/** Make sure rates cover the TCGplayer archive range; cheap when they already do (last 10 days only). */
export async function ensureFx(db: SqlDb, firstNeeded: string): Promise<number> {
  const existing = parsePacked((await db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [FX_KEY]))?.value);
  const from = existing.length && existing[0]![0] <= firstNeeded ? new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10) : firstNeeded;
  return refreshFx(db, from);
}
