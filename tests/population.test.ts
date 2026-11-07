import { describe, expect, test } from "bun:test";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { duePsaSpecs, parsePsaPop, rowToPopulation } from "../server/services/population.ts";

describe("population reports", () => {
  test("PSA spec population model → compact grades, total, gems", () => {
    const parsed = parsePsaPop({ SpecID: 55, Description: "1999 POKEMON GERMAN BASE #4 CHARIZARD-HOLO", PSAPop: { Total: 1234, Auth: 4, Grade10: 100, Grade9: 500, Grade8_5: 20, Grade8: 400, Grade7: 150, Grade9Q: 30, Grade8Q: 30 }, PSADNAPop: {} });
    expect(parsed.total).toBe(1234);
    expect(parsed.grades).toEqual({ "10": 100, "9": 500, "8.5": 20, "8": 400, "7": 150, auth: 4, q: 60 });
    const pop = rowToPopulation({ card_id: "base1-4", company: "PSA", spec_id: "55", description: parsed.description, total: parsed.total, grades: JSON.stringify(parsed.grades), fetched_at: "2026-11-07T00:00:00Z" });
    expect(pop.gems).toBe(100); expect(pop.gemRate).toBeCloseTo(100 / 1234);
    expect(pop.grades.map(([g]) => g)).toEqual(["10", "9", "8.5", "8", "7", "auth"]);
  });
  test("due specs come from resolved certs and skip fresh reports", async () => {
    const db = await openBunDb(":memory:");
    await db.exec(`INSERT INTO series(id, name_de) VALUES ('base', 'Base'); INSERT INTO sets(id, series_id, name_de) VALUES ('base1', 'base', 'Grundset');
      INSERT INTO cards(id, set_id, local_id, name_de) VALUES ('base1-4', 'base1', '4', 'Glurak'), ('base1-58', 'base1', '58', 'Pikachu');
      INSERT INTO psa_certs(cert_no, fetched_at, payload, card_id) VALUES
        ('1', '2026-11-01T00:00:00Z', '{"certNo":"1","specId":55,"grade":10}', 'base1-4'),
        ('2', '2026-11-01T00:00:00Z', '{"certNo":"2","specId":55,"grade":9}', 'base1-4'),
        ('3', '2026-11-01T00:00:00Z', '{"certNo":"3","specId":77,"grade":10}', 'base1-58'),
        ('4', '2026-11-01T00:00:00Z', 'null', NULL),
        ('5', '2026-11-01T00:00:00Z', '{"certNo":"5","specId":null}', 'base1-58');`);
    expect(await duePsaSpecs(db, 10)).toEqual([{ cardId: "base1-4", specId: "55" }, { cardId: "base1-58", specId: "77" }]);
    await db.run("INSERT INTO populations(card_id, company, spec_id, total, grades, fetched_at) VALUES ('base1-4', 'PSA', '55', 10, '{\"10\":10}', ?)", [new Date().toISOString()]);
    expect(await duePsaSpecs(db, 10)).toEqual([{ cardId: "base1-58", specId: "77" }]);
    await db.run("UPDATE populations SET fetched_at = '2026-01-01T00:00:00Z'");
    expect((await duePsaSpecs(db, 10)).map((d) => d.cardId)).toEqual(["base1-58", "base1-4"]);
  });
});
