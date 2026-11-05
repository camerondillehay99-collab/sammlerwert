import { describe, expect, test } from "bun:test";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { parsePacked, packPoints, mergePacked, downsample, fxLookup, convert, snapshotFrom, cardSeries } from "../server/pricing/history.ts";
import { groupBaseName, matchGroups, matchProducts, normNumber, variantOfSubType, appendDailyPoints, pointsFromPrices, SET_GROUPS } from "../server/ingest/tcgplayer.ts";
import { conditionLadder } from "../server/pricing/engine.ts";
import { parseFx } from "../server/ingest/fx.ts";

describe("packed series", () => {
  test("round trip, sorting and de-duplication", () => {
    const packed = packPoints([["2024-02-09", 12.7], ["2024-02-08", 12.5], ["2024-02-09", 12.75]]);
    expect(packed).toBe("20240208:12.5;20240209:12.75");
    expect(parsePacked(packed)).toEqual([["2024-02-08", 12.5], ["2024-02-09", 12.75]]);
    expect(parsePacked("garbage;20240101:x;20240102:3")).toEqual([["2024-01-02", 3]]);
    expect(mergePacked("20240208:1", "20240207:2;20240208:1.5")).toBe("20240207:2;20240208:1.5");
    expect(mergePacked(null, "20240208:1")).toBe("20240208:1");
  });
  test("downsample keeps ends", () => {
    const pts = Array.from({ length: 100 }, (_, i) => [`2024-01-${String((i % 28) + 1).padStart(2, "0")}`, i] as [string, number]);
    const d = downsample(pts, 10);
    expect(d.length).toBe(10); expect(d[0]).toEqual(pts[0]); expect(d[9]).toEqual(pts[99]);
  });
  test("fx lookup uses the latest rate on or before a date (weekends)", () => {
    const rate = fxLookup(parseFx({ rates: { "2024-02-08": { EUR: 0.93 }, "2024-02-09": { EUR: 0.92 } } }));
    expect(rate("2024-02-09")).toBe(0.92); expect(rate("2024-02-11")).toBe(0.92); expect(rate("2024-02-08")).toBe(0.93); expect(rate("2024-01-01")).toBe(0.93);
    expect(convert([["2024-02-10", 100]], rate)).toEqual([["2024-02-10", 92]]);
  });
  test("snapshot picks the richest series and summarises a year", () => {
    const pts = Array.from({ length: 400 }, (_, i) => [new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), 10 + i / 10] as [string, number]);
    const snap = snapshotFrom("x", [
      { key: "cardmarket|all|normal", source: "cardmarket", label: "cm", language: "all", variant: "normal", currency: "EUR", points: [["2026-01-01", 5]] },
      { key: "tcgplayer|en|normal", source: "tcgplayer", label: "tcg", language: "en", variant: "normal", currency: "EUR", points: pts },
    ]);
    expect(snap.source).toBe("tcgplayer"); expect(snap.value).toBeCloseTo(49.9, 5); expect(snap.prev).toBeCloseTo(49.8, 5);
    expect(snap.spark.length).toBeLessThanOrEqual(60); expect(snap.n).toBe(400); expect(snap.recent.length).toBe(5);
    expect(snap.change1y).toBeGreaterThan(0); expect(snap.low1y!).toBeLessThan(snap.high1y!);
  });
});

describe("TCGplayer matching", () => {
  const groups = [
    { groupId: 23237, name: "SV: Scarlet & Violet 151", abbreviation: "MEW", publishedOn: null },
    { groupId: 3170, name: "SWSH12: Silver Tempest", abbreviation: "SWSH12", publishedOn: null },
    { groupId: 17674, name: "SWSH12: Silver Tempest Trainer Gallery", abbreviation: "SWSH12: TG", publishedOn: null },
    { groupId: 24831, name: "ME06: Delta Reign", abbreviation: "DLR", publishedOn: null },
    { groupId: 1418, name: "WoTC Promo", abbreviation: "PR", publishedOn: null },
    { groupId: 1451, name: "XY Promos", abbreviation: "PR", publishedOn: null },
    { groupId: 99999, name: "SV11: Future Set", abbreviation: "ZZZ", publishedOn: null },
  ];
  test("curated map, then unique abbreviation, then name", () => {
    const m = matchGroups([
      { id: "sv03.5", abbreviation: "MEW", name_en: "151" }, { id: "swsh12", abbreviation: "SIT", name_en: "Silver Tempest" },
      { id: "swsh12tg", abbreviation: "SIT:TG", name_en: "Silver Tempest Trainer Gallery" },
      { id: "me06", abbreviation: "DLR", name_en: "Delta Reign" }, { id: "sv11", abbreviation: "FUT", name_en: "Future Set" },
      { id: "basep", abbreviation: null, name_en: "Wizards Black Star Promos" }, { id: "nope", abbreviation: "PR", name_en: "Nothing" },
    ], groups);
    expect(m.get("sv03.5")).toEqual([23237]); expect(m.get("swsh12")).toEqual([3170]); expect(m.get("swsh12tg")).toEqual([17674]);
    expect(m.get("me06")).toEqual([24831]); expect(m.get("sv11")).toEqual([99999]); expect(m.get("basep")).toEqual([1418]);
    expect(m.has("nope")).toBe(false); // ambiguous abbreviation, no name match
    expect(groupBaseName("SM - Team Up")).toBe("team up"); expect(groupBaseName("SWSH01: Sword & Shield Base Set")).toBe("sword shield");
  });
  test("every curated group id is a number and every set has at least one", () => {
    for (const [set, ids] of Object.entries(SET_GROUPS)) { expect(ids.length).toBeGreaterThan(0); for (const id of ids) expect(Number.isInteger(id)).toBe(true); void set; }
  });
  test("collector numbers normalise across both catalogues", () => {
    expect(normNumber("TG01/TG30")).toBe("TG1"); expect(normNumber("TG01")).toBe("TG1"); expect(normNumber("001/165")).toBe("1"); expect(normNumber("199")).toBe("199");
    expect(normNumber("SV045/SV122")).toBe("SV45"); expect(normNumber("SV045")).toBe("SV45"); expect(normNumber("RC1/RC32")).toBe("RC1"); expect(normNumber("28a")).toBe("28A"); expect(normNumber("SWSH001")).toBe("SWSH1");
  });
  test("products match by number, ties by name, junk skipped", () => {
    const products = [
      { productId: 1, name: "Charizard ex - 199/165", cleanName: null, number: "199/165" },
      { productId: 2, name: "Pikachu", cleanName: null, number: "025/165" },
      { productId: 3, name: "Pikachu (Cosmos Holo)", cleanName: null, number: "025/165" },
      { productId: 4, name: "Code Card - 151 Booster", cleanName: null, number: "025/165" },
      { productId: 5, name: "Booster Box", cleanName: null, number: null },
    ];
    const m = matchProducts([{ id: "a", local_id: "199", name_en: "Charizard ex" }, { id: "b", local_id: "025", name_en: "Pikachu" }, { id: "c", local_id: "7", name_en: "Nope" }], products);
    expect(m.get("a")).toBe(1); expect(m.get("b")).toBe(2); expect(m.has("c")).toBe(false);
  });
  test("finish → variant", () => {
    expect(variantOfSubType("Normal")).toBe("normal"); expect(variantOfSubType("Holofoil")).toBe("holo"); expect(variantOfSubType("Reverse Holofoil")).toBe("reverse");
    expect(variantOfSubType("1st Edition Holofoil")).toBe("firstEdition"); expect(variantOfSubType("Unlimited")).toBe("normal"); expect(variantOfSubType("Jumbo")).toBeNull();
  });
});

describe("price_series append + card series", () => {
  test("appends one point per day idempotently and serves EUR series", async () => {
    const db = await openBunDb(":memory:");
    await db.exec("INSERT INTO series(id, name_de) VALUES ('sv', 'SV'); INSERT INTO sets(id, series_id, name_en, abbreviation) VALUES ('sv03.5', 'sv', '151', 'MEW');");
    await db.run("INSERT INTO cards(id, set_id, local_id, name_en, variants, tcgp_product_id) VALUES ('sv03.5-199', 'sv03.5', '199', 'Charizard ex', '{\"holo\":true}', 1)");
    await db.run("INSERT INTO meta(key, value) VALUES ('fx_usd_eur', '20240208:0.5')");
    const index = new Map([[1, ["sv03.5-199"]]]);
    const pts = pointsFromPrices([{ productId: 1, subTypeName: "Holofoil", marketPrice: 100, lowPrice: null, midPrice: null }, { productId: 2, subTypeName: "Holofoil", marketPrice: 5, lowPrice: null, midPrice: null }], index);
    expect(pts).toEqual([{ cardId: "sv03.5-199", variant: "holo", price: 100 }]);
    await appendDailyPoints(db, "2026-11-03", pts);
    await appendDailyPoints(db, "2026-11-03", pts); // same day again → no change
    await appendDailyPoints(db, "2026-11-04", [{ cardId: "sv03.5-199", variant: "holo", price: 110 }]);
    await appendDailyPoints(db, "2026-11-01", [{ cardId: "sv03.5-199", variant: "holo", price: 90 }]); // older than last → ignored
    const row = (await db.first<{ points: string; n: number; first_date: string; last_date: string }>("SELECT points, n, first_date, last_date FROM price_series"))!;
    expect(row.points).toBe("20261103:100;20261104:110"); expect(row.n).toBe(2); expect(row.first_date).toBe("2026-11-03"); expect(row.last_date).toBe("2026-11-04");
    const series = await cardSeries(db, { id: "sv03.5-199", set_id: "sv03.5", cm_product_id: null, variants: '{"holo":true}' });
    expect(series.length).toBe(1);
    expect(series[0]!.key).toBe("tcgplayer|en|holo"); expect(series[0]!.points).toEqual([["2026-11-03", 50], ["2026-11-04", 55]]);
    db.close();
  });
});

describe("condition ladder", () => {
  test("estimates from NM until two sales exist in a bucket", () => {
    const now = "2026-11-04T00:00:00Z";
    const l = conditionLadder([{ price: 40, soldAt: "2026-10-30", condition: "EX" }, { price: 44, soldAt: "2026-10-20", condition: "GD" }], 100, now);
    expect(l.map((c) => c.code)).toEqual(["NM", "LP", "MP", "HP", "DMG"]);
    expect(l[0]!.value).toBe(100); expect(l[0]!.method).toBe("estimate");
    expect(l[1]!.method).toBe("sales"); expect(l[1]!.value).toBeGreaterThan(39); expect(l[1]!.value).toBeLessThan(45);
    expect(l[4]!.value).toBe(30);
    expect(conditionLadder([], null, now).every((c) => c.value == null)).toBe(true);
  });
});
