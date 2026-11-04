// D1 REST adapter against a local mock of the Cloudflare D1 /query endpoint (backed by bun:sqlite).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { D1HttpDb, inline, literal } from "../server/db/d1-http.ts";
import { SCHEMA } from "../server/db/bun-sqlite.ts";
import { importCatalog, importCardDetails } from "../server/ingest/tcgdex.ts";
import { importGuide, linkedProductIds } from "../server/ingest/cardmarket.ts";
import { recomputeFactors } from "../server/pricing/engine.ts";
import { searchCards, getCardDetail } from "../server/services/catalog.ts";

const raw = new Database(":memory:");
let server: ReturnType<typeof Bun.serve>;
let db: D1HttpDb;

beforeAll(() => {
  raw.exec(SCHEMA);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer test-token") return Response.json({ success: false, errors: [{ code: 10000, message: "auth" }] }, { status: 403 });
      const { sql, params } = (await req.json()) as { sql: string; params: unknown[] };
      const statements = params?.length ? [sql] : sql.split(/;\n|;$/).map((s) => s.trim()).filter(Boolean);
      const result = [];
      for (const s of statements) {
        const q = raw.query(s);
        if (/^\s*(SELECT|WITH)/i.test(s)) result.push({ results: q.all(...(params as never[] ?? [])), success: true, meta: { rows_read: 1 } });
        else { const r = q.run(...(params as never[] ?? [])); result.push({ results: [], success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid), rows_written: r.changes } }); }
      }
      return Response.json({ success: true, errors: [], result });
    },
  });
  db = new D1HttpDb({ accountId: "acc", databaseId: "dbid", apiToken: "test-token", baseUrl: `http://localhost:${server.port}/client/v4`, batchSize: 50 });
});
afterAll(() => server.stop());

describe("inline()", () => {
  test("replaces placeholders outside quotes and escapes values", () => {
    expect(inline("INSERT INTO t (a, b, c) VALUES (?, ?, ?)", ["O'Neil", 1.5, null])).toBe("INSERT INTO t (a, b, c) VALUES ('O''Neil', 1.5, NULL)");
    expect(inline("SELECT * FROM t WHERE k = 'what?' AND v = ?", ["ä?ö"])).toBe("SELECT * FROM t WHERE k = 'what?' AND v = 'ä?ö'");
    expect(() => inline("SELECT ?", [])).toThrow();
    expect(literal(true)).toBe("1");
  });
});

describe("D1HttpDb end to end", () => {
  test("catalog import (incremental), details, guide, factors, then reads", async () => {
    const setDetails = new Map([["sv03.5", { id: "sv03.5", name: "151", serie: { id: "sv", name: "Karmesin & Purpur" }, releaseDate: "2023-09-22", abbreviation: { official: "MEW" }, cardCount: { official: 165, total: 207 },
      cards: [{ id: "sv03.5-199", localId: "199", name: "Glurak-ex" }, { id: "sv03.5-006", localId: "006", name: "Glurak-ex" }] }]]);
    const input = { seriesDe: [{ id: "sv", name: "Karmesin & Purpur" }], setsDe: [{ id: "sv03.5", name: "151" }], setsEn: [{ id: "sv03.5", name: "151" }],
      cardsDe: [], cardsEn: [{ id: "sv03.5-199", name: "Charizard ex" }, { id: "sv03.5-006", name: "Charizard ex" }], setDetails };
    const first = await importCatalog(db, input, true);
    expect(first.newCards).toBe(2);
    const second = await importCatalog(db, input, true);
    expect(second.newCards).toBe(0); // incremental: nothing rewritten
    await importCardDetails(db, [{ id: "sv03.5-199", rarity: "SIR", variants: { normal: false, holo: true }, pricing: { cardmarket: { idProduct: 724981 } } }]);
    const linked = await linkedProductIds(db);
    expect([...linked]).toEqual([724981]);
    const g = await importGuide(db, { createdAt: "2026-11-04T02:47:37+0100", priceGuides: [{ idProduct: 724981, trend: 320, avg7: 310, avg30: 290, avg: 300, low: 250 }, { idProduct: 1, trend: 9 }] }, linked);
    expect(g.guideRows).toBe(1); expect(g.filtered).toBe(true);
    await recomputeFactors(db);
    const s = await searchCards(db, "glurak", { sort: "value" });
    expect(s.total).toBe(2); expect(s.items[0]!.id).toBe("sv03.5-199"); expect(s.items[0]!.valueDe).toBe(320);
    const d = (await getCardDetail(db, "sv03.5-199"))!;
    expect(d.prices.find((p) => p.language === "de")!.variant).toBe("holo");
    expect(d.history.length).toBe(2);
    expect(db.stats.requests).toBeGreaterThan(5);
  });
});
