/**
 * Minimal async SQL interface shared by both runtimes:
 *   - Bun + bun:sqlite (local dev, self-hosting, tests)
 *   - Cloudflare Workers + D1 (production)
 * Everything above this layer is runtime-agnostic. The interface deliberately mirrors D1's
 * constraints (no interactive transactions – use `batch`, ≤ 100 bound parameters per statement).
 */
export type SqlValue = string | number | null | boolean | bigint | ArrayBuffer | Uint8Array;
export type Row = Record<string, unknown>;

export interface Statement { sql: string; params: SqlValue[] }

export interface SqlDb {
  /** Run a read query and return all rows. */
  all<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** First row or null. */
  first<T = Row>(sql: string, params?: SqlValue[]): Promise<T | null>;
  /** Run a write statement. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number }>;
  /** Run several statements atomically (one transaction) and in order. */
  batch(statements: Statement[]): Promise<void>;
  /** Execute raw multi-statement SQL (schema / DDL). */
  exec(sql: string): Promise<void>;
}

export const MAX_PARAMS = 100; // D1 limit per statement; we honour it everywhere.

export const stmt = (sql: string, ...params: SqlValue[]): Statement => ({ sql, params });

/**
 * Builds multi-row INSERT statements that stay under the bound-parameter limit.
 *   bulkInsert("cards", ["id","name"], rows, "ON CONFLICT(id) DO UPDATE SET name = excluded.name")
 */
export function bulkInsert(table: string, columns: string[], rows: SqlValue[][], conflict = "", verb = "INSERT"): Statement[] {
  if (!rows.length) return [];
  const perRow = columns.length;
  const rowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / perRow));
  const out: Statement[] = [];
  const tuple = `(${columns.map(() => "?").join(",")})`;
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const chunk = rows.slice(i, i + rowsPerStmt);
    out.push({
      sql: `${verb} INTO ${table} (${columns.join(",")}) VALUES ${chunk.map(() => tuple).join(",")} ${conflict}`.trim(),
      params: chunk.flat(),
    });
  }
  return out;
}

/** Run statements in batches of `size` (keeps each D1 batch request reasonably small). */
export async function runBatches(db: SqlDb, statements: Statement[], size = 200): Promise<void> {
  for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}

/** Expand an IN (...) list safely within the parameter limit: returns chunks of values. */
export function chunks<T>(arr: T[], size = MAX_PARAMS - 5): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");
