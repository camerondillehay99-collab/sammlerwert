// Card scanner: parsing of the vision model's answer and catalogue matching (no model involved).
import { beforeAll, describe, expect, test } from "bun:test";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { rebuildFts } from "../server/ingest/tcgdex.ts";
import { findCandidates, numberKey, parseFacts, parseNumber, scanImage, useScanProvider } from "../server/scan.ts";

const db = await openBunDb(":memory:");

beforeAll(async () => {
  await db.exec(`INSERT INTO series(id, name_de) VALUES ('sv', 'Karmesin & Purpur'), ('base', 'Basis');
    INSERT INTO sets(id, series_id, name_de, name_en, abbreviation, release_date, card_count_official, card_count_total) VALUES
      ('sv03.5', 'sv', '151', '151', 'MEW', '2023-09-22', 165, 207),
      ('sv04', 'sv', 'Paradoxrift', 'Paradox Rift', 'PAR', '2023-11-03', 182, 266),
      ('base1', 'base', 'Grundset', 'Base Set', 'BS', '1999-01-09', 102, 102);
    INSERT INTO cards(id, set_id, local_id, name_de, name_en, rarity, variants, detail_loaded) VALUES
      ('sv03.5-199', 'sv03.5', '199', 'Glurak-ex', 'Charizard ex', 'SIR', '{"normal":true}', 1),
      ('sv03.5-006', 'sv03.5', '006', 'Glurak-ex', 'Charizard ex', 'Doppelt Selten', '{"normal":true}', 1),
      ('sv04-199', 'sv04', '199', 'Roaring Moon ex', 'Donnersichel-ex', 'Ultra Selten', '{"normal":true}', 1),
      ('base1-4', 'base1', '4', 'Glurak', 'Charizard', 'Selten Holo', '{"holo":true,"normal":false}', 1),
      ('base1-58', 'base1', '58', 'Pikachu', 'Pikachu', 'Häufig', '{"normal":true}', 1);`);
  await rebuildFts(db);
});

describe("parsing", () => {
  test("collector numbers in all the shapes they are printed", () => {
    expect(parseNumber("199/165")).toEqual({ number: "199", total: 165 });
    expect(parseNumber(" 025 / 198")).toEqual({ number: "025", total: 198 });
    expect(parseNumber("SV049/SV122")).toEqual({ number: "SV049", total: 122 });
    expect(parseNumber("TG12/TG30")).toEqual({ number: "TG12", total: 30 });
    expect(parseNumber("4/102")).toEqual({ number: "4", total: 102 });
    expect(parseNumber("006")).toEqual({ number: "006", total: null });
    expect(parseNumber("unreadable")).toEqual({ number: null, total: null });
    expect(numberKey("006")).toBe("6"); expect(numberKey("sv049")).toBe("SV49"); expect(numberKey("TG12")).toBe("TG12");
  });
  test("model answers with prose around the JSON, nulls and a slab", () => {
    const f = parseFacts('Here is the JSON:\n{"name": "Glurak-ex", "number": "199/165", "language": "German", "finish": "holo", "grading": "PSA 10", "set": null}');
    expect(f.name).toBe("Glurak-ex"); expect(f.number).toBe("199"); expect(f.total).toBe(165);
    expect(f.language).toBe("de"); expect(f.finish).toBe("holo"); expect(f.gradingCompany).toBe("PSA"); expect(f.grade).toBe(10); expect(f.setHint).toBeNull();
    const g = parseFacts('{"name": "Charizard", "number": null, "language": "en", "finish": "normal", "grading": "null", "set": "Base Set",}');
    expect(g.number).toBeNull(); expect(g.setHint).toBe("Base Set"); expect(g.gradingCompany).toBeNull();
    expect(parseFacts("I cannot read this image").name).toBeNull();
  });
});

describe("matching", () => {
  test("number + set size + name pick the right card among same-number cards", async () => {
    const c = await findCandidates(db, parseFacts('{"name":"Glurak-ex","number":"199/165","language":"de","finish":"holo"}'));
    expect(c[0]!.card.id).toBe("sv03.5-199");
    for (const r of ["Nummer", "Setgröße", "Name"]) expect(c[0]!.reasons).toContain(r);
    expect(c.map((x) => x.card.id)).toContain("sv04-199"); // offered as an alternative, ranked lower
    expect(c[0]!.score).toBeGreaterThan(c[1]!.score + 2);
  });
  test("a misread number still resolves through the name; vintage without set size", async () => {
    const byName = await findCandidates(db, parseFacts('{"name":"Glurak","number":"4/102","language":"de"}'));
    expect(byName[0]!.card.id).toBe("base1-4");
    const noNumber = await findCandidates(db, parseFacts('{"name":"Pikachu","number":null,"language":"en"}'));
    expect(noNumber[0]!.card.id).toBe("base1-58");
  });
  test("scanImage uses the provider, logs the scan and reports confidence", async () => {
    useScanProvider({ readCard: async () => '{"name":"Glurak-ex","number":"006/165","language":"de","finish":"holo","grading":null,"set":"151"}' });
    const r = await scanImage(db, new Uint8Array([1, 2, 3]), "image/jpeg", null);
    expect(r.best!.card.id).toBe("sv03.5-006");
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.alternatives[0]!.card.id).toBe("sv03.5-199");
    expect((await db.first<{ n: number }>("SELECT COUNT(*) n FROM scans"))!.n).toBe(1);
    useScanProvider(null);
  });
});
