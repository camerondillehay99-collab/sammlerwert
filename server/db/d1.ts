// Cloudflare D1 implementation of SqlDb.
import type { Row, SqlDb, SqlValue, Statement } from "./adapter.ts";

/** Structural D1 types (avoids depending on @cloudflare/workers-types at build time). */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Row>(): Promise<{ results: T[] }>;
  first<T = Row>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

export class D1Db implements SqlDb {
  constructor(private d1: D1DatabaseLike) {}
  private prep(sql: string, params: SqlValue[]) { return this.d1.prepare(sql).bind(...params.map(norm)); }
  async all<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> { return (await this.prep(sql, params).all<T>()).results; }
  async first<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | null> { return (await this.prep(sql, params).first<T>()) ?? null; }
  async run(sql: string, params: SqlValue[] = []) {
    const r = await this.prep(sql, params).run();
    return { changes: r.meta.changes ?? 0, lastInsertRowid: r.meta.last_row_id ?? 0 };
  }
  async batch(statements: Statement[]) {
    if (!statements.length) return;
    await this.d1.batch(statements.map((s) => this.prep(s.sql, s.params)));
  }
  /** Independent reads in one network round trip – the single biggest latency win on D1. */
  async queryMany(statements: Statement[]): Promise<Row[][]> {
    if (!statements.length) return [];
    const res = await this.d1.batch<{ results: Row[] }>(statements.map((s) => this.prep(s.sql, s.params)));
    return res.map((r) => r.results ?? []);
  }
  async exec(sql: string) {
    // D1 exec() expects one statement per line: strip comments, collapse each statement onto one line.
    const noComments = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    const statements = noComments.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (statements.length) await this.d1.exec(statements.join(";\n") + ";");
  }
}

/** D1 rejects booleans/undefined; normalise like the SQLite adapter does implicitly. */
function norm(v: SqlValue | undefined): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  return v;
}
