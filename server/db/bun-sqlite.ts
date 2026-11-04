// bun:sqlite implementation of SqlDb (local dev, self-hosting, tests).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Row, SqlDb, SqlValue, Statement } from "./adapter.ts";
import { MAX_PARAMS } from "./adapter.ts";

const SCHEMA = await Bun.file(new URL("./schema.sql", import.meta.url)).text();

export class BunSqliteDb implements SqlDb {
  readonly raw: Database;
  /** Emulate D1 strictness (parameter limit) so tests catch violations early. */
  strict = true;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path, { create: true });
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;");
  }

  private check(params: SqlValue[]) {
    if (this.strict && params.length > MAX_PARAMS) throw new Error(`Statement binds ${params.length} parameters – D1 allows ${MAX_PARAMS}.`);
  }
  async all<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> { this.check(params); return this.raw.query(sql).all(...(params as never[])) as T[]; }
  async first<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | null> { this.check(params); return (this.raw.query(sql).get(...(params as never[])) as T | null) ?? null; }
  async run(sql: string, params: SqlValue[] = []) {
    this.check(params);
    const r = this.raw.query(sql).run(...(params as never[]));
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }
  async batch(statements: Statement[]) {
    for (const s of statements) this.check(s.params);
    this.raw.transaction(() => { for (const s of statements) this.raw.query(s.sql).run(...(s.params as never[])); })();
  }
  async exec(sql: string) { this.raw.exec(sql); }
  close() { this.raw.close(); }
}

export async function openBunDb(path: string): Promise<BunSqliteDb> {
  const db = new BunSqliteDb(path);
  await db.exec(SCHEMA);
  return db;
}

export { SCHEMA };
