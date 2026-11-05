import { describe, expect, test } from "bun:test";
import { computeQuote, learnFactor, normalizeToNm, decayWeight, primaryVariant, gradedValues } from "../server/pricing/engine.ts";
import { trimOutliers, weightedMedian, weightedQuantile } from "../server/pricing/stats.ts";

const NOW = "2026-11-04T12:00:00Z";
const d = (daysAgo: number) => new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();
const base = { cardId: "x", language: "de" as const, variant: "normal" as const, listings: [], factor: { value: 1, n: 0 }, past7: null, past30: null, now: NOW };

describe("stats", () => {
  test("weighted median & quantiles", () => {
    expect(weightedMedian([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 10, w: 1 }])).toBe(2);
    expect(weightedQuantile([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 3, w: 1 }, { v: 4, w: 1 }], 0.25)).toBe(1);
    expect(weightedMedian([])).toBeNull();
  });
  test("outlier trimming removes a wild sale but keeps tight data", () => {
    const pts = [10, 11, 10.5, 9.8, 10.2, 95].map((v) => ({ v, w: 1 }));
    const kept = trimOutliers(pts);
    expect(kept.map((p) => p.v)).not.toContain(95);
    expect(kept.length).toBe(5);
    expect(trimOutliers([{ v: 5, w: 1 }, { v: 5, w: 1 }, { v: 5, w: 1 }, { v: 5, w: 1 }]).length).toBe(4);
  });
});

describe("engine helpers", () => {
  test("time decay halves at 21 days", () => {
    expect(decayWeight(0)).toBe(1);
    expect(decayWeight(21)).toBeCloseTo(0.5, 5);
  });
  test("condition normalisation", () => {
    expect(normalizeToNm(85, "EX")).toBeCloseTo(100, 5);
    expect(normalizeToNm(100, "NM")).toBe(100);
    expect(normalizeToNm(95, null)).toBeCloseTo(100, 5);
  });
  test("primary variant prefers normal, then holo", () => {
    expect(primaryVariant(new Set(["reverse", "normal"]))).toBe("normal");
    expect(primaryVariant(new Set(["holo", "reverse"]))).toBe("holo");
  });
});

describe("computeQuote", () => {
  test("guide only → guide × language factor, moderate confidence", () => {
    const q = computeQuote({ ...base, sales: [], guide: { trend: 100, avg: 98, avg1: 101, avg7: 99, avg30: 95, low: 80 }, factor: { value: 0.8, n: 5 } });
    expect(q.value).toBe(80);
    expect(q.method).toBe("guide×language_factor");
    expect(q.confidence).toBeGreaterThan(0.5);
    expect(q.confidence).toBeLessThan(0.75);
    expect(q.sources).toEqual({ cardmarket_guide: 1 });
    expect(q.trend30).toBeCloseTo(100 / 95 - 1, 3);
  });
  test("sales dominate the guide as they accumulate", () => {
    const sales = Array.from({ length: 12 }, (_, i) => ({ price: 50 + (i % 3), soldAt: d(i), condition: "NM", verified: true, source: "ebay_de" }));
    const q = computeQuote({ ...base, sales, guide: { trend: 100, avg: 100, avg1: 100, avg7: 100, avg30: 100, low: 90 } });
    expect(q.value!).toBeLessThan(70);
    expect(q.value!).toBeGreaterThan(50);
    expect(q.method).toBe("sales+guide");
    expect(q.sources.sales!).toBeGreaterThan(0.6);
    expect(q.nSales30d).toBe(12);
  });
  test("few sales → closer to guide, agreement raises confidence", () => {
    const agree = computeQuote({ ...base, sales: [{ price: 100, soldAt: d(2), condition: "NM", verified: true, source: "ebay_de" }], guide: { trend: 100, avg: 100, avg1: null, avg7: 100, avg30: 100, low: 90 } });
    const disagree = computeQuote({ ...base, sales: [{ price: 30, soldAt: d(2), condition: "NM", verified: true, source: "ebay_de" }], guide: { trend: 100, avg: 100, avg1: null, avg7: 100, avg30: 100, low: 90 } });
    expect(agree.value).toBe(100);
    expect(agree.confidence).toBeGreaterThan(disagree.confidence);
    expect(disagree.value!).toBeGreaterThan(60); // single sale cannot drag the value below the blend
  });
  test("unverified user reports weigh half", () => {
    const v = computeQuote({ ...base, sales: [{ price: 40, soldAt: d(1), condition: "NM", verified: true, source: "ebay_de" }], guide: { trend: 100, avg: 100, avg1: null, avg7: null, avg30: null, low: null } });
    const u = computeQuote({ ...base, sales: [{ price: 40, soldAt: d(1), condition: "NM", verified: false, source: "user" }], guide: { trend: 100, avg: 100, avg1: null, avg7: null, avg30: null, low: null } });
    expect(u.value!).toBeGreaterThan(v.value!);
  });
  test("old sales decay out, stale (>120 d) are ignored", () => {
    const q = computeQuote({ ...base, sales: [{ price: 10, soldAt: d(200), condition: "NM", verified: true, source: "ebay_de" }], guide: null });
    expect(q.value).toBeNull();
    expect(q.method).toBe("none");
  });
  test("listings only act as a floor with capped weight", () => {
    const listings = Array.from({ length: 10 }, (_, i) => ({ price: 20 + i, seenAt: d(1), condition: null }));
    const q = computeQuote({ ...base, sales: [], listings, guide: { trend: 100, avg: 100, avg1: null, avg7: 100, avg30: 100, low: 90 } });
    expect(q.value!).toBeLessThan(100);
    expect(q.value!).toBeGreaterThan(75);
    expect(q.sources.listings!).toBeLessThanOrEqual(0.25);
    const only = computeQuote({ ...base, sales: [], listings, guide: null });
    expect(only.method).toBe("listings_only");
    expect(only.confidence).toBeLessThanOrEqual(0.25);
  });
  test("trend uses own history when available", () => {
    const q = computeQuote({ ...base, sales: [], guide: { trend: 110, avg: 110, avg1: null, avg7: 100, avg30: 100, low: 90 }, past7: 100, past30: 120 });
    expect(q.trend7).toBeCloseTo(0.1, 3);
    expect(q.trend30).toBeCloseTo(110 / 120 - 1, 3);
  });
});

describe("learnFactor", () => {
  test("shrinks toward global with few observations", () => {
    expect(learnFactor([], 1).value).toBe(1);
    const f = learnFactor([0.5], 1);
    expect(f.n).toBe(1);
    expect(f.value).toBeGreaterThan(0.5);
    expect(f.value).toBeLessThan(1);
    const many = learnFactor(Array(50).fill(0.5), 1);
    expect(many.value).toBeCloseTo(0.545, 2);
  });
  test("ignores absurd ratios", () => {
    expect(learnFactor([0.01, 50, 1.2], 1).n).toBe(1);
  });
});

describe("gradedValues", () => {
  const now = "2026-11-04T00:00:00Z";
  const sale = (price: number, daysAgo: number, company = "PSA", grade = 10, verified = true) =>
    ({ price, soldAt: new Date(Date.parse(now) - daysAgo * 86_400_000).toISOString(), company, grade, verified });
  test("values a grade from its own sales, trims outliers, estimates missing PSA grades", () => {
    const sales = [sale(300, 2), sale(320, 10), sale(290, 20), sale(3000, 5), sale(150, 3, "PSA", 9), sale(160, 30, "PSA", 9), sale(500, 1, "BGS", 9.5)];
    const out = gradedValues(sales, 100, now);
    const psa10 = out.find((g) => g.company === "PSA" && g.grade === 10)!;
    expect(psa10.method).toBe("sales"); expect(psa10.n).toBe(4);
    expect(psa10.value).toBeGreaterThan(280); expect(psa10.value).toBeLessThan(330); // the 3000 € outlier is trimmed
    const psa9 = out.find((g) => g.company === "PSA" && g.grade === 9)!;
    expect(psa9.method).toBe("sales"); expect(psa9.n).toBe(2);
    expect(out.find((g) => g.company === "BGS" && g.method === "sales")).toBeUndefined(); // a single sale is not a value
    expect(out[0]!.company).toBe("PSA"); expect(out[0]!.grade).toBe(10); // sorted PSA first, highest grade first
  });
  test("multiplier estimates only when no sales exist and the raw value is meaningful", () => {
    const est = gradedValues([], 40, now);
    expect(est.every((g) => g.method === "multiplier")).toBe(true);
    expect(est.slice(0, 3).map((g) => `${g.company} ${g.grade}`)).toEqual(["PSA 10", "PSA 9", "PSA 8"]);
    expect(new Set(est.map((g) => g.company))).toEqual(new Set(["PSA", "BGS", "CGC", "TAG"]));
    expect(est[0]!.value).toBeCloseTo(120, 5);
    expect(gradedValues([], 1, now)).toEqual([]);
    expect(gradedValues([sale(50, 400), sale(55, 390)], null, now)).toEqual([]); // too old
  });
});
