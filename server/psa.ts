/**
 * PSA certificate lookup via the PSA Public API (https://www.psacard.com/publicapi).
 * PSA has no "vault" or "my collection" endpoint – what exists is per-certificate data: what the card is and its grade.
 * We cache every answer (psa_certs) so a cert is fetched once per installation.
 */
import type { SqlDb } from "./db/adapter.ts";
import { config } from "./config.ts";
import { nowIso } from "./db/index.ts";
import { findCandidates, type ScanCandidate, type ScanFacts } from "./scan.ts";

export interface PsaCert {
  certNo: string; specId: number | null; year: string | null; brand: string | null; category: string | null; cardNumber: string | null; subject: string | null;
  variety: string | null; grade: number | null; gradeText: string | null; labelType: string | null; totalPopulation: number | null; populationHigher: number | null;
}

export function psaConfigured(): boolean { return !!config.psa.token; }

export const normalizeCert = (s: string) => s.replace(/\D/g, "");

/** "GEM MT 10" → 10, "MINT 9" → 9, "NM-MT+ 8.5" → 8.5, "AUTHENTIC" → null */
export function parsePsaGrade(s: string | null | undefined): number | null {
  const m = (s ?? "").match(/(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)(?!\d)/);
  return m ? Number(m[1]) : null;
}

/** Map a PSA record to the facts the card matcher understands. PSA brands read like "POKEMON GERMAN BASE SET" or "POKEMON SWSH SILVER TEMPEST". */
export function certToFacts(c: PsaCert): ScanFacts {
  const brand = `${c.brand ?? ""} ${c.variety ?? ""}`.toUpperCase();
  const language = /GERMAN|DEUTSCH/.test(brand) ? "de" : /JAPAN/.test(brand) ? "jp" : /FRENCH/.test(brand) ? "fr" : /ITALIAN/.test(brand) ? "it" : /SPANISH/.test(brand) ? "es" : /PORTUG/.test(brand) ? "pt" : "en";
  const setHint = (c.brand ?? "").replace(/^\s*(\d{4}\s+)?POKEMON\s*/i, "").replace(/\b(GERMAN|JAPANESE|FRENCH|ITALIAN|SPANISH|ENGLISH)\b/gi, "").replace(/\s+/g, " ").trim() || null;
  const subject = (c.subject ?? "").replace(/[-–]\s*(HOLO|REVERSE|FULL ART|1ST ED\.?|1ST EDITION).*$/i, "").trim();
  const name = subject ? subject.charAt(0) + subject.slice(1).toLowerCase() : null;
  const num = (c.cardNumber ?? "").match(/^#?\s*([A-Z]{0,4}\d{1,4}[A-Z]?)/i)?.[1] ?? null;
  const finish = /REVERSE/i.test(`${c.variety} ${c.subject}`) ? "reverse" : /HOLO/i.test(`${c.variety} ${c.subject}`) ? "holo" : null;
  return { name, number: num, total: null, language, finish, gradingCompany: "PSA", grade: c.grade, setHint, raw: JSON.stringify(c) };
}

function mapApi(certNo: string, j: Record<string, unknown>): PsaCert {
  const p = (j.PSACert ?? j) as Record<string, unknown>;
  const s = (k: string) => (p[k] == null || p[k] === "" ? null : String(p[k]));
  const n = (k: string) => (p[k] == null || p[k] === "" || Number.isNaN(Number(p[k])) ? null : Number(p[k]));
  return { certNo, specId: n("SpecID"), year: s("Year"), brand: s("Brand"), category: s("Category"), cardNumber: s("CardNumber"), subject: s("Subject"), variety: s("Variety"),
    grade: parsePsaGrade(s("CardGrade")), gradeText: s("CardGrade"), labelType: s("LabelType"), totalPopulation: n("TotalPopulation"), populationHigher: n("PopulationHigher") };
}

export class PsaError extends Error { constructor(message: string, public status: number) { super(message); } }

export async function lookupCert(db: SqlDb, certRaw: string): Promise<PsaCert | null> {
  const certNo = normalizeCert(certRaw);
  if (!certNo || certNo.length < 6 || certNo.length > 12) throw new PsaError("Bitte eine gültige PSA-Zertifikatsnummer (6–12 Ziffern) eingeben.", 400);
  const cached = await db.first<{ payload: string }>("SELECT payload FROM psa_certs WHERE cert_no = ?", [certNo]);
  if (cached) return JSON.parse(cached.payload) as PsaCert | null;
  if (!psaConfigured()) throw new PsaError("PSA-Abfragen sind noch nicht aktiviert (PSA_API_TOKEN fehlt).", 503);
  const res = await fetch(`${config.psa.base}/cert/GetByCertNumber/${certNo}`, { headers: { authorization: `bearer ${config.psa.token}`, accept: "application/json" } });
  if (res.status === 404) { await db.run("INSERT OR REPLACE INTO psa_certs(cert_no, fetched_at, payload) VALUES (?, ?, 'null')", [certNo, nowIso()]); return null; }
  if (res.status === 401 || res.status === 403) throw new PsaError("PSA hat den API-Token abgelehnt.", 502);
  if (res.status === 429) throw new PsaError("PSA-Tageslimit erreicht – bitte später erneut versuchen.", 429);
  if (!res.ok) throw new PsaError(`PSA antwortet mit ${res.status}.`, 502);
  const j = (await res.json()) as Record<string, unknown>;
  const cert = mapApi(certNo, j);
  if (!cert.subject && !cert.brand) { await db.run("INSERT OR REPLACE INTO psa_certs(cert_no, fetched_at, payload) VALUES (?, ?, 'null')", [certNo, nowIso()]); return null; }
  await db.run("INSERT OR REPLACE INTO psa_certs(cert_no, fetched_at, payload) VALUES (?, ?, ?)", [certNo, nowIso(), JSON.stringify(cert)]);
  return cert;
}

/** Certificate → facts → catalogue candidates (reuses the scanner's matcher; the PSA brand string is a strong set hint). */
export async function resolveCert(db: SqlDb, certRaw: string): Promise<{ cert: PsaCert | null; facts: ScanFacts | null; candidates: ScanCandidate[] }> {
  const cert = await lookupCert(db, certRaw);
  if (!cert) return { cert: null, facts: null, candidates: [] };
  const facts = certToFacts(cert);
  const candidates = await findCandidates(db, facts, 5, { setWeight: 3 });
  if (candidates[0]) await db.run("UPDATE psa_certs SET card_id = ? WHERE cert_no = ?", [candidates[0].card.id, cert.certNo]).catch(() => {});
  return { cert, facts, candidates };
}
