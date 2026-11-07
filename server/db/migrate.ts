/**
 * Idempotent schema upgrades for databases created before a column or table existed (live D1).
 * schema.sql stays the source of truth for fresh databases; every entry here must also be reflected there.
 * Runs once per Worker isolate (first request) and at the start of the nightly job – a handful of PRAGMA reads.
 */
import type { SqlDb } from "./adapter.ts";

const COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["users", "totp_secret", "TEXT"],
  ["users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "totp_enabled_at", "TEXT"],
  ["users", "recovery_codes", "TEXT"],
  ["sessions", "mfa_pending", "INTEGER NOT NULL DEFAULT 0"],
  ["collections", "share_token", "TEXT"],
  ["collections", "description", "TEXT"],
  ["collections", "color", "TEXT"],
  ["collections", "sort_order", "INTEGER NOT NULL DEFAULT 0"],
  ["collection_items", "source", "TEXT"],
  ["cards", "tcgp_product_id", "INTEGER"],
  ["sales", "listing_type", "TEXT NOT NULL DEFAULT 'unknown'"],
];

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS psa_certs (cert_no TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, payload TEXT NOT NULL, card_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS ui_translations (lang TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (lang, key))`,
  `CREATE TABLE IF NOT EXISTS tcgp_groups (group_id INTEGER PRIMARY KEY, set_id TEXT, name TEXT, abbreviation TEXT, published_on TEXT, products INTEGER, matched INTEGER, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS price_series (card_id TEXT NOT NULL, source TEXT NOT NULL, variant TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', points TEXT NOT NULL DEFAULT '', first_date TEXT, last_date TEXT, n INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (card_id, source, variant))`,
  `CREATE TABLE IF NOT EXISTS populations (card_id TEXT NOT NULL REFERENCES cards(id), company TEXT NOT NULL, spec_id TEXT, description TEXT, total INTEGER NOT NULL DEFAULT 0, grades TEXT NOT NULL DEFAULT '{}', fetched_at TEXT NOT NULL, PRIMARY KEY (card_id, company))`,
];

let done: Promise<string[]> | null = null;
export function ensureSchema(db: SqlDb): Promise<string[]> {
  if (!done) done = migrate(db).catch((e) => { done = null; throw e; });
  return done;
}

/** Column names from a CREATE TABLE statement: comments stripped, split on top-level commas only. */
export function columnsOf(ddl: string): Set<string> {
  const noComments = ddl.replace(/--[^\n]*/g, "");
  const body = noComments.slice(noComments.indexOf("(") + 1, noComments.lastIndexOf(")"));
  const parts: string[] = []; let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return new Set(parts.map((p) => p.trim().split(/\s+/)[0]!.replace(/["`]/g, "")).filter((c) => c && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(c)));
}

export async function migrate(db: SqlDb): Promise<string[]> {
  const applied: string[] = [];
  // One round trip: the CREATE TABLE statements of every table we care about, parsed for column names.
  const tables = [...new Set([...COLUMNS.map((c) => c[0]), ...TABLES.map((t) => t.match(/EXISTS (\w+)/)![1]!)])];
  const rows = await db.all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(",")})`, tables);
  const known = new Map<string, Set<string>>();
  for (const r of rows) known.set(r.name, columnsOf(r.sql));
  for (const [table, column, ddl] of COLUMNS) {
    const cols = known.get(table);
    if (!cols || cols.has(column)) continue;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    cols.add(column); applied.push(`${table}.${column}`);
  }
  for (const sql of TABLES) { const name = sql.match(/EXISTS (\w+)/)![1]!; if (!known.has(name)) { await db.exec(sql); applied.push(name); } }
  return applied;
}
