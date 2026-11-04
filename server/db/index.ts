// Shared database handle + small helpers. Runtime-agnostic (no Bun / Node imports).
import type { SqlDb } from "./adapter.ts";
export type { SqlDb } from "./adapter.ts";

let _db: SqlDb | null = null;
export function db(): SqlDb {
  if (!_db) throw new Error("Datenbank nicht initialisiert (useDb() fehlt).");
  return _db;
}
export function useDb(instance: SqlDb) { _db = instance; }

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export function jsonOr<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
