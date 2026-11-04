import { describe, expect, test } from "bun:test";
import { classifyListing } from "../server/ingest/listing-classifier.ts";
import { parseGuideRow, parseProductRow, extractRows } from "../server/ingest/cardmarket.ts";
import { productBaseName, normalizeName } from "../server/ingest/matcher.ts";
import { buildQuery } from "../server/ingest/ebay.ts";

const glurak = { nameDe: "Glurak-ex", nameEn: "Charizard ex", localId: "199", setTotal: 165 };
const pikachu = { nameDe: "Pikachu", nameEn: "Pikachu", localId: "25", setTotal: 102 };

describe("listing classifier", () => {
  test("German name implies German language", () => {
    const f = classifyListing("Pokemon Glurak ex 199/165 151 Holo Near Mint", glurak);
    expect(f.language).toBe("de"); expect(f.languageConfidence).toBeGreaterThan(0.8); expect(f.matchesCard).toBe(true); expect(f.isLot).toBe(false);
  });
  test("English name without tags → English", () => {
    const f = classifyListing("Charizard ex 199/165 Pokemon 151 NM", glurak);
    expect(f.language).toBe("en"); expect(f.matchesCard).toBe(true);
  });
  test("identical names need an explicit tag", () => {
    expect(classifyListing("Pikachu 25/102 Base Set", pikachu).language).toBeNull();
    expect(classifyListing("Pikachu 25/102 Base Set DEUTSCH", pikachu).language).toBe("de");
    expect(classifyListing("Pikachu 25/102 Grundset DE", pikachu).language).toBe("de");
    expect(classifyListing("Pikachu 25/102 Base Set english", pikachu).language).toBe("en");
  });
  test("Japanese and other languages", () => {
    expect(classifyListing("Glurak ex 199/165 japanese", glurak).language).toBe("jp");
    expect(classifyListing("Charizard ex 199/165 italiano", glurak).language).toBe("other");
  });
  test("grading, variants, lots, junk", () => {
    const g = classifyListing("Glurak ex 199/165 PSA 10 GEM MINT deutsch", glurak);
    expect(g.gradingCompany).toBe("PSA"); expect(g.grade).toBe(10);
    expect(classifyListing("Glurak ex 199/165 reverse holo", glurak).variant).toBe("reverse");
    expect(classifyListing("Glurak ex 199/165 1. Edition", glurak).variant).toBe("firstEdition");
    expect(classifyListing("Glurak ex 199/165 Lot 3x", glurak).isLot).toBe(true);
    expect(classifyListing("Glurak ex 199/165 Sammlung Konvolut", glurak).isLot).toBe(true);
    expect(classifyListing("Glurak ex 199/165 Proxy custom metal card", glurak).isJunk).toBe(true);
  });
  test("number must match the card", () => {
    expect(classifyListing("Glurak ex 006/165", glurak).matchesCard).toBe(false);
    expect(classifyListing("Glurak ex 1991/165", glurak).matchesCard).toBe(false);
    expect(classifyListing("Glurak ex #199", glurak).matchesCard).toBe(true);
  });
  test("eBay query is German-first", () => {
    expect(buildQuery(glurak)).toBe("Glurak-ex 199 pokemon");
    expect(buildQuery({ nameDe: null, nameEn: "Mew", localId: "007" })).toBe("Mew 7 pokemon");
  });
});

describe("cardmarket parsers (real format, Nov 2026)", () => {
  test("price guide row with -holo keys", () => {
    const r = parseGuideRow({ idProduct: 427231, idCategory: 51, avg: 2.55, low: 0.5, trend: 2.91, avg1: 2.47, avg7: 2.89, avg30: 2.68, "avg-holo": null, "low-holo": null, "trend-holo": 4.67, "avg1-holo": 3.45, "avg7-holo": 4.69, "avg30-holo": 4.55 })!;
    expect(r.idProduct).toBe(427231); expect(r.trend).toBe(2.91); expect(r.foilTrend).toBe(4.67); expect(r.foilAvg).toBeNull(); expect(r.foilAvg30).toBe(4.55);
  });
  test("tolerates alternative key spellings", () => {
    const r = parseGuideRow({ productId: "5", avgFoil: "1,5", trend_holo: 2 })!;
    expect(r.idProduct).toBe(5); expect(r.foilAvg).toBe(1.5); expect(r.foilTrend).toBe(2);
    expect(parseGuideRow({ foo: 1 })).toBeNull();
  });
  test("product row", () => {
    const p = parseProductRow({ idProduct: 273532, name: "Weedle [Multiply]", idCategory: 51, categoryName: "Pokémon Single", idExpansion: 1585, idMetacard: 340471, dateAdded: "0000-00-00 00:00:00" }, true)!;
    expect(p.name).toBe("Weedle [Multiply]"); expect(p.idExpansion).toBe(1585); expect(p.isSingle).toBe(true);
  });
  test("extractRows handles wrapper objects and arrays", () => {
    expect(extractRows({ version: 1, createdAt: "2026-11-04T02:47:37+0100", priceGuides: [{ a: 1 }] })).toEqual({ rows: [{ a: 1 }], createdAt: "2026-11-04T02:47:37+0100" });
    expect(extractRows([{ a: 1 }]).rows.length).toBe(1);
    expect(extractRows({ products: [] }).rows).toEqual([]);
    expect(extractRows(null).rows).toEqual([]);
  });
});

describe("matcher helpers", () => {
  test("product base name strips attack suffix", () => {
    expect(productBaseName("Charizard ex [Brave Wing | Explosive Vortex]")).toBe("Charizard ex");
    expect(productBaseName("Nemona")).toBe("Nemona");
  });
  test("normalizeName is accent/punctuation insensitive", () => {
    expect(normalizeName("Pokémon-Fänger’s")).toBe("pokemon fangers");
    expect(normalizeName("Charizard ex")).toBe(normalizeName("CHARIZARD  EX"));
  });
});
