// Runs the Cloudflare Worker entry against a simulated D1 (bun:sqlite behind the D1 binding API).
import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import worker from "../worker/index.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../server/db/d1.ts";
import { SCHEMA } from "../server/db/bun-sqlite.ts";

function fakeD1(): D1DatabaseLike & { raw: Database } {
  const raw = new Database(":memory:");
  const prep = (sql: string, params: unknown[] = []): D1PreparedStatementLike & { sql: string; params: unknown[] } => ({
    sql, params,
    bind: (...values: unknown[]) => { if (values.length > 100) throw new Error("D1_ERROR: too many parameters"); return prep(sql, values); },
    all: async <T>() => ({ results: raw.query(sql).all(...(params as never[])) as T[] }),
    first: async <T>() => (raw.query(sql).get(...(params as never[])) as T | null) ?? null,
    run: async () => { const r = raw.query(sql).run(...(params as never[])); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    raw,
    prepare: (sql: string) => prep(sql),
    batch: async (stmts) => { raw.transaction(() => { for (const s of stmts as unknown as Array<{ sql: string; params: unknown[] }>) raw.query(s.sql).run(...(s.params as never[])); })(); return []; },
    exec: async (sql: string) => { let n = 0; for (const line of sql.split("\n")) { if (line.trim()) { raw.exec(line); n++; } } return { count: n, duration: 0 }; },
  };
}

const DB = fakeD1();
const env = { DB, ASSETS: { fetch: async () => new Response("<html>spa</html>", { headers: { "content-type": "text/html" } }) }, BRAND_NAME: "Sammlerwert", ADMIN_EMAILS: "admin@example.com" };
let cookie = "";
const call = async (method: string, path: string, body?: unknown) => {
  const res = await worker.fetch(new Request(`https://sammlerwert.example${path}`, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]!;
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
};

beforeAll(async () => {
  // Apply the schema exactly the way the Worker's D1 adapter would (one statement per line).
  const { D1Db } = await import("../server/db/d1.ts");
  await new D1Db(DB).exec(SCHEMA);
  DB.raw.exec(`INSERT INTO series(id, name_de) VALUES ('sv', 'Karmesin & Purpur');
    INSERT INTO sets(id, series_id, name_de, name_en, abbreviation, release_date, card_count_official) VALUES ('sv03.5', 'sv', '151', '151', 'MEW', '2023-09-22', 165);
    INSERT INTO cards(id, set_id, local_id, name_de, name_en, rarity, variants, detail_loaded, cm_product_id, cm_match_method, cm_match_confidence) VALUES
      ('sv03.5-199', 'sv03.5', '199', 'Glurak-ex', 'Charizard ex', 'SIR', '{"normal":false,"holo":true}', 1, 1001, 'tcgdex', 1);
    INSERT INTO cm_products(id_product, name, id_expansion) VALUES (1001, 'Charizard ex [Brave Wing | Explosive Vortex]', 5328);
    INSERT INTO cm_price_guide(id_product, date, avg, low, trend, avg7, avg30) VALUES (1001, date('now'), 300, 250, 320, 310, 290);
    INSERT INTO meta(key, value) VALUES ('cm_guide_date', date('now'));
    INSERT INTO cards_fts(card_id, name_de, name_en, set_name_de, set_name_en, local_id) VALUES ('sv03.5-199', 'Glurak-ex', 'Charizard ex', '151', '151', '199');`);
});

describe("worker", () => {
  test("schema applies through D1 exec (FTS5, defaults) and SPA falls through to assets", async () => {
    const r = await worker.fetch(new Request("https://sammlerwert.example/karte/sv03.5-199"), env);
    expect(await r.text()).toContain("spa");
  });
  test("cron reprice + API end to end on D1 semantics", async () => {
    await worker.scheduled({ cron: "15 4 * * *", scheduledTime: Date.now() }, { ...env, CARDMARKET_DOWNLOAD_BASE: "https://127.0.0.1:9/nope" }, { waitUntil: () => {} });
    // daily_refresh fails on the (blocked) download but the job runner must record it and not throw
    await new Promise((r) => setTimeout(r, 50));
    const { recomputeFactors } = await import("../server/pricing/engine.ts");
    const { D1Db } = await import("../server/db/d1.ts");
    const f = await recomputeFactors(new D1Db(DB));
    expect(f.languages).toContain("de");
    expect((await call("GET", "/api/health")).body.ok).toBe(true);
    expect((await call("GET", "/api/search?q=glurak")).body.items[0].valueDe).toBe(320);
    expect((await call("POST", "/api/auth/register", { email: "admin@example.com", password: "passwort123" })).status).toBe(201);
    const add = await call("POST", "/api/items", { cardId: "sv03.5-199", language: "de", variant: "normal", condition: "NM", purchasePriceEur: 200 });
    expect(add.status).toBe(201); expect(add.body.item.variant).toBe("holo"); expect(add.body.item.currentValue).toBe(320);
    expect((await call("GET", "/api/portfolio")).body.totalValue).toBe(320);
    expect((await call("POST", "/api/items/1/image")).status).toBe(503); // no R2 bound → graceful
    const jobs = await call("GET", "/api/admin/jobs");
    expect(jobs.status).toBe(200); expect(jobs.body.runs.length).toBeGreaterThan(0);
    const run = await call("POST", "/api/admin/jobs/snapshots");
    expect(run.body.detail).toContain("snapshots");
  });
});
