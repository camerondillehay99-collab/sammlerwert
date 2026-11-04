import { describe, expect, test } from "bun:test";
import KEYS from "../shared/i18n-keys.json";
import { EN } from "../shared/i18n-en.ts";
import { openBunDb } from "../server/db/bun-sqlite.ts";
import { uiDictionary, useTextAi, UI_LANGS } from "../server/i18n.ts";

describe("i18n", () => {
  test("every German UI string has a hand-written English translation with the same placeholders", () => {
    const missing = (KEYS as string[]).filter((k) => !(k in EN));
    expect(missing).toEqual([]);
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join("|");
    const broken = (KEYS as string[]).filter((k) => ph(k) !== ph(EN[k]!));
    expect(broken).toEqual([]);
  });

  test("machine translation: placeholders are protected, results are cached in D1", async () => {
    const db = await openBunDb(":memory:");
    let calls = 0;
    useTextAi({ async run(_model, input) {
      calls++;
      const items = (JSON.parse(String((input.messages as Array<{ content: string }>)[0]!.content).match(/\n(\[[\s\S]*\])$/)![1]) as Array<{ i: number; de: string }>);
      expect((input as { response_format?: { type: string } }).response_format?.type).toBe("json_schema");
      // "translate" by prefixing; drop the placeholder on purpose in one string to prove the guard; answer out of order to prove index mapping
      return { response: JSON.stringify({ items: items.slice().reverse().map(({ i, de }) => ({ i, t: de.startsWith("{n} ausgewählt") ? "sélectionné" : `fr:${de}` })) }) };
    } });
    const first = await uiDictionary(db, "fr");
    expect(calls).toBeGreaterThan(0);
    expect(first.entries["Abbrechen"]).toBe("fr:Abbrechen");
    expect(first.entries["{n} ausgewählt"]).toBeUndefined(); // lost placeholder → not stored, client falls back to English
    expect(first.complete).toBe(false);
    const stored = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM ui_translations WHERE lang = 'fr'"))!.n;
    expect(stored).toBeGreaterThan(400);
    expect(UI_LANGS.fr).toBe("French");
    useTextAi(null);
  });
});
