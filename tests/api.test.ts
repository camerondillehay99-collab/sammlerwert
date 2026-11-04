// End-to-end API test against an in-memory database with a tiny synthetic catalogue.
import { beforeAll, describe, expect, test } from "bun:test";
import { useDb } from "../server/db/index.ts";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { matchRoute } from "../server/api/routes.ts";
import { rebuildFts } from "../server/ingest/tcgdex.ts";
import { recomputeFactors } from "../server/pricing/engine.ts";
import { ApiError } from "../server/http.ts";

const db = await openBunDb(":memory:");
useDb(db);
let cookie = "";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://test${path}`);
  const m = matchRoute(method, url.pathname);
  if (!m) throw new Error(`no route ${method} ${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json", cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const res = await m.route.handler(req, m.params, db);
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0]!;
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.message, code: e.code } };
    throw e;
  }
}

beforeAll(async () => {
  await db.exec(`INSERT INTO series(id, name_de) VALUES ('sv', 'Karmesin & Purpur');
    INSERT INTO sets(id, series_id, name_de, name_en, abbreviation, release_date, card_count_official, card_count_total) VALUES ('sv03.5', 'sv', '151', '151', 'MEW', '2023-09-22', 165, 207);
    INSERT INTO cards(id, set_id, local_id, name_de, name_en, rarity, variants, detail_loaded, cm_product_id, cm_match_method, cm_match_confidence) VALUES
      ('sv03.5-199', 'sv03.5', '199', 'Glurak-ex', 'Charizard ex', 'Spezial-Illustration Selten', '{"normal":true,"holo":false,"reverse":false}', 1, 1001, 'tcgdex', 1),
      ('sv03.5-025', 'sv03.5', '025', 'Pikachu', 'Pikachu', 'Häufig', '{"normal":true,"reverse":true}', 1, 1002, 'tcgdex', 1);
    INSERT INTO cm_products(id_product, name, id_expansion) VALUES (1001, 'Charizard ex [Brave Wing | Explosive Vortex]', 5328), (1002, 'Pikachu [Gnaw]', 5328);
    INSERT INTO cm_price_guide(id_product, date, avg, low, trend, avg1, avg7, avg30, foil_trend, foil_avg30) VALUES (1001, date('now'), 180, 150, 190, 185, 188, 175, NULL, NULL), (1002, date('now'), 0.1, 0.02, 0.09, 0.1, 0.1, 0.1, 0.6, 0.55);`);
  await rebuildFts(db);
  await db.run("INSERT INTO meta(key, value) VALUES ('cm_guide_date', date('now'))");
  await recomputeFactors(db);
});

describe("API", () => {
  test("health + search (German name, number, English name)", async () => {
    expect((await call("GET", "/api/health")).body.ok).toBe(true);
    expect((await call("GET", "/api/search?q=glurak")).body.items[0].id).toBe("sv03.5-199");
    expect((await call("GET", "/api/search?q=charizard%20ex")).body.items[0].nameDe).toBe("Glurak-ex");
    expect((await call("GET", "/api/search?q=199/165")).body.items[0].id).toBe("sv03.5-199");
    expect((await call("GET", "/api/search?q=glürak")).body.total).toBe(1); // diacritics-insensitive
  });
  test("card detail carries quotes, guide and reverse variant", async () => {
    const c = (await call("GET", "/api/cards/sv03.5-025")).body;
    expect(c.prices.find((p: { language: string; variant: string }) => p.language === "de" && p.variant === "reverse").value).toBe(0.6);
    expect(c.guide.trend).toBe(0.09);
    expect((await call("GET", "/api/cards/nope")).status).toBe(404);
  });
  test("auth flow and validation", async () => {
    expect((await call("POST", "/api/auth/register", { email: "bad", password: "12345678" })).status).toBe(400);
    expect((await call("POST", "/api/auth/register", { email: "a@b.de", password: "short" })).status).toBe(400);
    const r = await call("POST", "/api/auth/register", { email: "a@b.de", password: "passwort123", name: "Cam" });
    expect(r.status).toBe(201); expect(cookie).toContain("sw_session=");
    expect((await call("POST", "/api/auth/register", { email: "A@b.de", password: "passwort123" })).body.code).toBe("email_taken");
    expect((await call("GET", "/api/auth/me")).body.user.email).toBe("a@b.de");
    const saved = cookie; cookie = "";
    expect((await call("GET", "/api/portfolio")).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { email: "a@b.de", password: "wrong" })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { email: "a@b.de", password: "passwort123" })).status).toBe(200);
    cookie = saved;
  });
  test("collection CRUD, valuation and plan limits", async () => {
    const add = await call("POST", "/api/items", { cardId: "sv03.5-199", language: "de", condition: "EX", purchasePriceEur: 120, quantity: 2 });
    expect(add.status).toBe(201);
    expect(add.body.item.currentValue).toBeCloseTo(190 * 0.85, 2);
    const p = (await call("GET", "/api/portfolio")).body;
    expect(p.totalValue).toBeCloseTo(190 * 0.85 * 2, 1); expect(p.totalCost).toBe(240); expect(p.insights.length).toBeGreaterThan(0);
    const upd = await call("PATCH", `/api/items/${add.body.item.id}`, { gradingCompany: "PSA", grade: 10, quantity: 1 });
    expect(upd.body.item.currentValue).toBeCloseTo(190 * 3, 2);
    expect((await call("POST", "/api/items", { cardId: "unknown" })).status).toBe(400);
    expect((await call("POST", "/api/items", { cardId: "sv03.5-025", quantity: 60 })).status).toBe(402); // free plan: 50 cards
    expect((await call("DELETE", `/api/items/${add.body.item.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/items/${add.body.item.id}`)).status).toBe(404);
  });
  test("community sale report reprices the card", async () => {
    const before = (await call("GET", "/api/cards/sv03.5-199")).body.prices.find((p: { language: string }) => p.language === "de").value;
    const r = await call("POST", "/api/cards/sv03.5-199/sales", { priceEur: 120, soldAt: new Date().toISOString().slice(0, 10), language: "de", condition: "NM" });
    expect(r.status).toBe(201);
    const after = r.body.prices.find((p: { language: string }) => p.language === "de");
    expect(after.value).toBeLessThan(before); expect(after.nSales30d).toBe(1); expect(after.method).toBe("sales+guide");
    // unverified community sales do not move the language factor on their own
    await recomputeFactors(db);
    expect((await db.first<{ n: number }>("SELECT n FROM language_factors WHERE set_id = 'sv03.5' AND language = 'de'"))).toBeNull();
    expect((await call("POST", "/api/cards/sv03.5-199/sales", { priceEur: -5 })).status).toBe(400);
  });
  test("watchlist & export gating", async () => {
    expect((await call("POST", "/api/watchlist", { cardId: "sv03.5-199" })).status).toBe(201);
    expect((await call("GET", "/api/watchlist")).body.items.length).toBe(1);
    expect((await call("GET", "/api/export.csv")).status).toBe(402);
    await db.run("UPDATE users SET plan = 'sammler'");
    const csv = await call("GET", "/api/export.csv");
    expect(csv.status).toBe(200); expect(String(csv.body)).toContain("Marktwert");
  });
  test("admin routes are protected", async () => {
    expect((await call("GET", "/api/admin/jobs")).status).toBe(403);
  });
});
