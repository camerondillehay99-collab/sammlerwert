// Importer and 2FA primitives: pure functions, no network.
import { describe, expect, test } from "bun:test";
import { detectSource, mapColumns, parseCondition, parseCsv, parseDate, parseGrading, parsePrice, parseVariant, sniffDelimiter } from "../server/import.ts";
import { base32Decode, base32Encode, consumeRecoveryCode, generateRecoveryCodes, hashRecoveryCodes, hotp, totp, verifyTotp } from "../server/totp.ts";
import { certToFacts, parsePsaGrade } from "../server/psa.ts";
import { isExcludedSet } from "../server/ingest/tcgdex.ts";

describe("catalogue scope", () => {
  test("Pokémon TCG Pocket never enters the catalogue", () => {
    expect(isExcludedSet("A1", "tcgp")).toBe(true); expect(isExcludedSet("B2a", null)).toBe(true); expect(isExcludedSet("P-A", null)).toBe(true);
    expect(isExcludedSet("sv03.5", "sv")).toBe(false); expect(isExcludedSet("base1", "base")).toBe(false); expect(isExcludedSet("swsh12.5", "swsh")).toBe(false);
  });
});

describe("csv", () => {
  test("delimiters, quotes, BOM", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(parseCsv(String.fromCharCode(0xfeff) + 'Name,Set\r\n"Charizard, ex","151"\r\n')).toEqual([["Name", "Set"], ["Charizard, ex", "151"]]);
    expect(parseCsv('a;b\n"x ""y""";2')).toEqual([["a", "b"], ['x "y"', "2"]]);
  });
  test("headers from the big three and our own export", () => {
    expect(mapColumns(["Card Name", "Set", "Card Number", "Condition", "Quantity", "Grade", "Purchase Price"])).toMatchObject({ name: 0, set: 1, number: 2, condition: 3, quantity: 4, grade: 5, price: 6 });
    expect(detectSource(["Card Name", "Set", "Card Number"])).toBe("collectr");
    expect(detectSource(["Name", "Set", "Number", "Grading Company", "Grade", "Purchase Price"])).toBe("cardladder");
    expect(detectSource(["Karte", "Englisch", "Nummer", "Set", "Karten-ID"])).toBe("sammlerwert");
    expect(detectSource(["Cert #", "Grade"])).toBe("psa");
    expect(mapColumns(["Karte", "Nummer", "Karten-ID", "Zertifikat"])).toMatchObject({ cardId: 2, cert: 3, name: 0, number: 1 });
  });
  test("field normalisation", () => {
    expect(parseCondition("Near Mint")).toBe("NM"); expect(parseCondition("Lightly Played")).toBe("EX"); expect(parseCondition("Moderately Played")).toBe("GD"); expect(parseCondition("Damaged")).toBe("PO"); expect(parseCondition("")).toBe("NM");
    expect(parseVariant("Reverse Holofoil")).toBe("reverse"); expect(parseVariant("Holofoil")).toBe("holo"); expect(parseVariant("1st Edition")).toBe("firstEdition"); expect(parseVariant("Normal")).toBe("normal");
    expect(parseGrading("PSA", "10")).toEqual({ company: "PSA", grade: 10 }); expect(parseGrading(undefined, "CGC 9.5")).toEqual({ company: "CGC", grade: 9.5 }); expect(parseGrading("", "")).toEqual({ company: null, grade: null }); expect(parseGrading("Raw", "")).toEqual({ company: null, grade: null });
    expect(parsePrice("$150.00", undefined)).toEqual({ eur: 138, original: "150 USD" }); expect(parsePrice("1.234,56", "EUR")).toEqual({ eur: 1234.56, original: null }); expect(parsePrice("12,5", "")).toEqual({ eur: 12.5, original: null }); expect(parsePrice("", "")).toEqual({ eur: null, original: null });
    expect(parseDate("03/15/2024")).toBe("2024-03-15"); expect(parseDate("15.03.2024")).toBe("2024-03-15"); expect(parseDate("2024-3-5")).toBe("2024-03-05"); expect(parseDate("")).toBeNull();
  });
});

describe("totp", () => {
  test("RFC 6238 vector and drift window", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(secret)).toEqual(new TextEncoder().encode("12345678901234567890"));
    expect(await hotp(secret, 1)).toBe("287082"); // T = 59 s → counter 1
    expect(await totp(secret, 59_000)).toBe("287082");
    expect(await totp(secret, 1111111109_000)).toBe("081804");
    expect(await verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(await verifyTotp(secret, "287 082", 85_000)).toBe(true); // one step late still accepted
    expect(await verifyTotp(secret, "287082", 200_000)).toBe(false);
    expect(await verifyTotp(secret, "28708", 59_000)).toBe(false);
  });
  test("recovery codes are single use and hashed", async () => {
    const codes = generateRecoveryCodes();
    expect(codes.length).toBe(8); expect(codes[0]).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);
    const hashes = await hashRecoveryCodes(codes);
    expect(hashes[0]).not.toContain(codes[0]!.slice(0, 5));
    const left = await consumeRecoveryCode(hashes, codes[3]!.toUpperCase());
    expect(left!.length).toBe(7);
    expect(await consumeRecoveryCode(left!, codes[3]!)).toBeNull();
  });
});

describe("psa", () => {
  test("grade text and brand → facts", () => {
    expect(parsePsaGrade("GEM MT 10")).toBe(10); expect(parsePsaGrade("NM-MT+ 8.5")).toBe(8.5); expect(parsePsaGrade("AUTHENTIC")).toBeNull();
    const f = certToFacts({ certNo: "12345678", specId: 1, year: "1999", brand: "POKEMON GERMAN BASE SET", category: "TCG Cards", cardNumber: "4", subject: "GLURAK-HOLO", variety: null, grade: 9, gradeText: "MINT 9", labelType: null, totalPopulation: 10, populationHigher: 2 });
    expect(f.language).toBe("de"); expect(f.setHint).toBe("BASE SET"); expect(f.name).toBe("Glurak"); expect(f.number).toBe("4"); expect(f.finish).toBe("holo"); expect(f.gradingCompany).toBe("PSA"); expect(f.grade).toBe(9);
  });
});
