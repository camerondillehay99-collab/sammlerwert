// Small fetch helpers (runtime-agnostic).
import { config } from "../config.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions { retries?: number; timeoutMs?: number; headers?: Record<string, string> }

/** GET with retries, timeout and a polite UA. Throws on final failure. */
export async function getText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { retries = 3, timeoutMs = 120_000, headers = {} } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": config.ingest.userAgent, accept: "application/json", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) throw new NotFound(url);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} for ${url}`);
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (err instanceof NotFound || err instanceof HttpError) throw err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function getJson<T = unknown>(url: string, opts?: FetchOptions): Promise<T> {
  return JSON.parse(await getText(url, opts)) as T;
}

export class NotFound extends Error { constructor(url: string) { super(`404 ${url}`); } }
export class HttpError extends Error { constructor(public status: number, url: string) { super(`HTTP ${status} ${url}`); } }
