#!/usr/bin/env bun
/**
 * Exports the local catalogue as SQL for `wrangler d1 execute --remote --file`, split to respect D1's
 * free-tier limit of 100 000 written rows per day (index rows count):
 *   part1 (deploy day): series, sets, cards (≈ 41k writes incl. idx_cards_set)
 *   part2 (next day, or automatically by the nightly job): FTS index, price guide for linked products, factors, meta
 */
import { Database } from "bun:sqlite";
import { config } from "../server/config.ts";
const db = new Database(config.dbPath, { readonly: true });
const esc = (v: unknown) => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
function dump(parts: string[], table: string, where = "", rowsPerStmt = 150, cols?: string[]) {
  const rows = db.query(`SELECT ${cols?.join(",") ?? "*"} FROM ${table} ${where}`).all() as Record<string, unknown>[];
  if (!rows.length) return 0;
  const c = cols ?? Object.keys(rows[0]!);
  for (let i = 0; i < rows.length; i += rowsPerStmt) parts.push(`INSERT OR REPLACE INTO ${table} (${c.join(",")}) VALUES ${rows.slice(i, i + rowsPerStmt).map((r) => `(${c.map((k) => esc(r[k])).join(",")})`).join(",\n")};`);
  console.log(`${table}: ${rows.length}`);
  return rows.length;
}
const p1: string[] = ["-- Sammlerwert D1 seed part 1 (catalogue) " + new Date().toISOString()];
dump(p1, "series"); dump(p1, "sets"); dump(p1, "cards", "", 60);
await Bun.write("deploy/d1-seed-part1.sql", p1.join("\n"));
const p2: string[] = ["-- Sammlerwert D1 seed part 2 (search index + prices) " + new Date().toISOString()];
p2.push("DELETE FROM cards_fts;", "INSERT INTO cards_fts(card_id, name_de, name_en, set_name_de, set_name_en, local_id) SELECT c.id, c.name_de, c.name_en, s.name_de, s.name_en, c.local_id FROM cards c JOIN sets s ON s.id = c.set_id;");
dump(p2, "cm_price_guide", "WHERE id_product IN (SELECT cm_product_id FROM cards WHERE cm_product_id IS NOT NULL)", 120);
dump(p2, "language_factors"); dump(p2, "meta");
await Bun.write("deploy/d1-seed-part2.sql", p2.join("\n"));
console.log(`part1 ${(Bun.file("deploy/d1-seed-part1.sql").size / 1e6).toFixed(1)} MB · part2 ${(Bun.file("deploy/d1-seed-part2.sql").size / 1e6).toFixed(1)} MB`);
