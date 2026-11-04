/**
 * D1 over the Cloudflare REST API – used by the nightly GitHub Actions job (and any script outside Workers).
 * Reads bind parameters natively; batches inline literals so one request carries many statements.
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query  { sql, params }
 */
import type { Row, SqlDb, SqlValue, Statement } from "./adapter.ts";

export interface D1HttpOptions { accountId: string; databaseId: string; apiToken: string; baseUrl?: string; batchSize?: number }

interface QueryResult { results?: Row[]; success: boolean; meta?: { changes?: number; last_row_id?: number; rows_written?: number; rows_read?: number } }
interface ApiResponse { success: boolean; errors?: Array<{ code: number; message: string }>; result?: QueryResult[] }

export class D1HttpDb implements SqlDb {
  readonly stats = { requests: 0, rowsWritten: 0, rowsRead: 0 };
  private url: string;
  constructor(private opts: D1HttpOptions) {
    this.url = `${opts.baseUrl ?? "https://api.cloudflare.com/client/v4"}/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`;
  }

  private async query(sql: string, params: SqlValue[] = []): Promise<QueryResult[]> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params: params.map(norm) }),
        signal: AbortSignal.timeout(120_000),
      });
      this.stats.requests++;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
      const json = (await res.json()) as ApiResponse;
      if (!res.ok || !json.success) throw new Error(`D1 API ${res.status}: ${json.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "unbekannter Fehler"}`);
      for (const r of json.result ?? []) { this.stats.rowsWritten += r.meta?.rows_written ?? 0; this.stats.rowsRead += r.meta?.rows_read ?? 0; }
      return json.result ?? [];
    }
  }

  async all<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> { return ((await this.query(sql, params))[0]?.results ?? []) as T[]; }
  async first<T = Row>(sql: string, params: SqlValue[] = []): Promise<T | null> { return ((await this.all<T>(sql, params))[0]) ?? null; }
  async run(sql: string, params: SqlValue[] = []) {
    const r = (await this.query(sql, params))[0];
    return { changes: r?.meta?.changes ?? 0, lastInsertRowid: r?.meta?.last_row_id ?? 0 };
  }
  /** Many statements per request: literals are inlined (the API binds params to a single statement only). */
  async batch(statements: Statement[]) {
    const size = this.opts.batchSize ?? 150;
    for (let i = 0; i < statements.length; i += size) {
      const sql = statements.slice(i, i + size).map((s) => inline(s.sql, s.params)).join(";\n") + ";";
      await this.query(sql);
    }
  }
  async exec(sql: string) { await this.query(sql); }
}

function norm(v: SqlValue): unknown { return typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "bigint" ? Number(v) : v === undefined ? null : v; }

export function literal(v: SqlValue): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `X'${[...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Replace positional `?` placeholders (outside quoted strings) with literals. */
export function inline(sql: string, params: SqlValue[]): string {
  let out = "", i = 0, p = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" ) { const j = findClose(sql, i, "'"); out += sql.slice(i, j + 1); i = j + 1; continue; }
    if (ch === '"') { const j = findClose(sql, i, '"'); out += sql.slice(i, j + 1); i = j + 1; continue; }
    if (ch === "?") { if (p >= params.length) throw new Error("Zu wenige Parameter für Statement"); out += literal(params[p++]!); i++; continue; }
    out += ch; i++;
  }
  if (p !== params.length) throw new Error(`Parameterzahl passt nicht (${params.length} gegeben, ${p} benutzt)`);
  return out;
}
function findClose(s: string, from: number, q: string): number {
  let i = from + 1;
  while (i < s.length) { if (s[i] === q) { if (s[i + 1] === q) { i += 2; continue; } return i; } i++; }
  return s.length - 1;
}
