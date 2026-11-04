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
];

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS psa_certs (cert_no TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, payload TEXT NOT NULL, card_id TEXT)`,
];

let done: Promise<string[]> | null = null;
export function ensureSchema(db: SqlDb): Promise<string[]> {
  if (!done) done = migrate(db).catch((e) => { done = null; throw e; });
  return done;
}

export async function migrate(db: SqlDb): Promise<string[]> {
  const applied: string[] = [];
  const known = new Map<string, Set<string>>();
  for (const [table, column, ddl] of COLUMNS) {
    let cols = known.get(table);
    if (!cols) {
      cols = new Set((await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name));
      known.set(table, cols);
    }
    if (cols.has(column)) continue;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    cols.add(column); applied.push(`${table}.${column}`);
  }
  for (const sql of TABLES) await db.exec(sql);
  return applied;
}
