import { describe, expect, test } from "bun:test";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { applyEnv } from "../server/config.ts";
import { compsListingType, compsQueries, fxAt, runCompsIngest, toSaleRow, dueCompsCards, refreshCardComps, type CompsItem, type FetchLike } from "../server/ingest/comps.ts";

const glurak = { nameDe: "Glurak", nameEn: "Charizard", localId: "4", setTotal: 102 };
const fx: Array<[string, number]> = [["2025-01-01", 0.9], ["2025-06-01", 0.85]];

const item = (o: Partial<CompsItem>): CompsItem => ({ item_id: "1", title: "Charizard 4/102 Base Set Holo", last_sold: "2025-06-10T12:00:00Z", price: 100, format: "FIXED_PRICE", best_offer: false, url: "https://www.ebay.com/itm/1", ...o });

describe("CompsAPI adapter", () => {
  test("queries: German and English name on eBay.de, English on eBay.com", () => {
    expect(compsQueries(glurak, "DE")).toEqual(["Glurak 4/102", "Charizard 4/102"]);
    expect(compsQueries(glurak, "US")).toEqual(["Charizard 4/102", "Glurak 4/102"]);
    expect(compsQueries({ nameDe: "Pikachu", nameEn: "Pikachu", localId: "025", setTotal: 102 }, "DE")).toEqual(["Pikachu 25/102"]);
    expect(compsQueries({ nameDe: null, nameEn: "Mew", localId: "TG01", setTotal: 30 }, "US")).toEqual(["Mew TG01"]);
  });
  test("sale type: auction, Buy It Now, accepted Best Offer", () => {
    expect(compsListingType({ format: "AUCTION", best_offer: null, bids: 12 })).toBe("auction");
    expect(compsListingType({ format: "FIXED_PRICE", best_offer: true })).toBe("best_offer");
    expect(compsListingType({ format: "FIXED_PRICE", best_offer: false })).toBe("fixed_price");
  });
  test("fx lookup takes the last rate on or before the sale date", () => {
    expect(fxAt(fx, "2025-03-01")).toBe(0.9); expect(fxAt(fx, "2025-06-01")).toBe(0.85); expect(fxAt(fx, "2024-12-31")).toBeNull();
  });
  test("rows: eBay.de in native EUR, eBay.com in USD at the day's rate, grader from the API, language from title/site", () => {
    const de = toSaleRow(item({ title: "Glurak 4/102 Grundset Holo deutsch", native_price: 120, native_currency: "EUR", price: 140, card: { graded: false, condition: "nm", language: "de" } }), glurak, "DE", fx)!;
    expect(de).toMatchObject({ language: "de", priceEur: 120, condition: "NM", gradingCompany: null, source: "ebay_de", listingType: "fixed_price", sourceRef: "1:2025-06-10" });
    const us = toSaleRow(item({ title: "Charizard 4/102 Base Set PSA 9", price: 1000, card: { graded: true, grader: "PSA", grade: 9, language: "en" }, format: "AUCTION", bids: 20 }), glurak, "US", fx)!;
    expect(us).toMatchObject({ language: "en", priceEur: 850, gradingCompany: "PSA", grade: 9, condition: null, source: "ebay", listingType: "auction" });
    const jp = toSaleRow(item({ title: "Charizard 4/102 Japanese Base Set", price: 200 }), glurak, "DE", fx)!;
    expect(jp.language).toBe("jp");
    // eBay.de listing under the English name without a language tag → an English card sold in Germany
    expect(toSaleRow(item({ title: "Charizard 4/102 Base Set Holo", native_price: 90, native_currency: "EUR" }), glurak, "DE", fx)!.language).toBe("en");
    // dropped: lots, wrong card, junk flags, missing rate
    expect(toSaleRow(item({ title: "Charizard 4/102 + Blastoise 2/102 lot" }), glurak, "US", fx)).toBeNull();
    expect(toSaleRow(item({ title: "Blastoise 2/102 Base Set" }), glurak, "US", fx)).toBeNull();
    expect(toSaleRow(item({ flags: ["replica"] }), glurak, "US", fx)).toBeNull();
    expect(toSaleRow(item({ last_sold: "2024-01-01T00:00:00Z" }), glurak, "US", fx)).toBeNull();
  });
  test("sweep: backfill pages, refresh window, budget, dedupe, status", async () => {
    applyEnv({ COMPSAPI_KEY: "test-key", COMPS_SITES: "DE,US", INGEST_DELAY_MS: "0" });
    const db = await openBunDb(":memory:");
    await db.exec(`INSERT INTO series(id, name_de) VALUES ('base', 'Base'); INSERT INTO sets(id, series_id, name_de, card_count_official) VALUES ('base1', 'base', 'Grundset', 102);
      INSERT INTO cards(id, set_id, local_id, name_de, name_en) VALUES ('base1-4', 'base1', '4', 'Glurak', 'Charizard'), ('base1-2', 'base1', '2', 'Turtok', 'Blastoise');
      INSERT INTO meta(key, value) VALUES ('fx_usd_eur', '20250101:0.9');`);
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = new URL(url); calls.push(`${u.searchParams.get("site")} ${u.searchParams.get("q")} d${u.searchParams.get("days")} p${u.searchParams.get("page")}`);
      const q = u.searchParams.get("q")!, page = Number(u.searchParams.get("page"));
      let items: CompsItem[] = [];
      if (q === "Glurak 4/102" && u.searchParams.get("site") === "DE" && page === 1) items = [item({ item_id: "a", title: "Glurak 4/102 Grundset Holo deutsch", native_price: 100, native_currency: "EUR" }), item({ item_id: "b", title: "Glurak 4/102 PSA 10 deutsch", native_price: 900, native_currency: "EUR", card: { graded: true, grader: "PSA", grade: 10 } })];
      if (q === "Charizard 4/102" && u.searchParams.get("site") === "US") items = page === 1 ? [item({ item_id: "c", price: 100 })] : [item({ item_id: "d", price: 80, last_sold: "2025-05-01T00:00:00Z" })];
      const next = q === "Charizard 4/102" && u.searchParams.get("site") === "US" && page === 1 ? 2 : null;
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, query: q, page, count: items.length, next_page: next, items }), text: async () => "" };
    };
    const s1 = await runCompsIngest(db, { budget: 100, fetchImpl }, () => {});
    expect(s1).toMatchObject({ cards: 2, sales: 4, backfilled: 2, errors: 0, stopped: null });
    expect(calls.filter((c) => c.startsWith("DE Glurak 4/102 d1095")).length).toBe(1);
    expect(calls.filter((c) => c.includes("US Charizard 4/102")).length).toBe(2); // two pages
    const rows = await db.all<{ source_ref: string; price_eur: number; grading_company: string | null; language: string }>("SELECT source_ref, price_eur, grading_company, language FROM sales ORDER BY source_ref");
    expect(rows.map((r) => r.source_ref)).toEqual(["a:2025-06-10", "b:2025-06-10", "c:2025-06-10", "d:2025-05-01"]);
    expect(rows[1]).toMatchObject({ grading_company: "PSA", price_eur: 900, language: "de" });
    expect(rows[2]).toMatchObject({ price_eur: 90, language: "en" });
    expect(JSON.parse((await db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'comps_status'"))!.value).sales).toBe(4);
    // nothing due right after a sweep; a week later the refresh asks only for the days since then
    expect(await dueCompsCards(db, 10)).toEqual([]);
    await db.run("UPDATE comps_refresh SET last_at = datetime('now', '-70 days')");
    calls.length = 0;
    const s2 = await runCompsIngest(db, { budget: 100, fetchImpl }, () => {});
    expect(s2.sales).toBe(4); // same items → INSERT OR IGNORE, no duplicates
    expect((await db.first<{ n: number }>("SELECT COUNT(*) n FROM sales"))!.n).toBe(4);
    expect(calls.every((c) => /d7[123] /.test(c))).toBe(true);
    // budget stops the run before the second card and leaves it due
    await db.run("UPDATE comps_refresh SET last_at = datetime('now', '-70 days')");
    const s3 = await runCompsIngest(db, { budget: 3, fetchImpl }, () => {});
    expect(s3.stopped).toBe("budget"); expect(s3.cards).toBe(1);
    expect((await dueCompsCards(db, 10)).length).toBe(2); // the interrupted card stays due as well
    // on-demand refresh: fresh cards are not fetched again
    await db.run("UPDATE comps_refresh SET last_at = datetime('now')");
    expect(await refreshCardComps(db, "base1-4")).toEqual({ refreshed: false, reason: "fresh" });
    applyEnv({ COMPSAPI_KEY: "" });
  });
  test("quota exhaustion ends the run and keeps the card due", async () => {
    applyEnv({ COMPSAPI_KEY: "test-key", COMPS_SITES: "DE", INGEST_DELAY_MS: "0" });
    const db = await openBunDb(":memory:");
    await db.exec(`INSERT INTO series(id, name_de) VALUES ('base', 'Base'); INSERT INTO sets(id, series_id, name_de, card_count_official) VALUES ('base1', 'base', 'Grundset', 102);
      INSERT INTO cards(id, set_id, local_id, name_de, name_en) VALUES ('base1-4', 'base1', '4', 'Glurak', 'Charizard');`);
    const fetchImpl: FetchLike = async () => ({ status: 429, headers: { get: () => null }, json: async () => ({}), text: async () => '{"ok":false,"error":"Monthly quota reached"}' });
    const s = await runCompsIngest(db, { budget: 10, fetchImpl }, () => {});
    expect(s.stopped).toBe("quota_reached"); expect(s.errors).toBe(1);
    expect((await dueCompsCards(db, 10)).map((c) => c.id)).toEqual(["base1-4"]);
    applyEnv({ COMPSAPI_KEY: "" });
  });
});
