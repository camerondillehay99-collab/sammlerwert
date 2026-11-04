#!/usr/bin/env bun
/**
 * Pulls queued code changes (table deploy_patches, written from the development workspace) into the checkout.
 *   bun run scripts/sync-from-d1.ts apply   → writes/deletes files, prints a summary, sets GitHub outputs
 *   bun run scripts/sync-from-d1.ts mark    → marks the applied rows after the commit was pushed
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID (optional, read from wrangler.toml)
 */
import { gunzipSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { D1HttpDb } from "../server/db/d1-http.ts";

interface PatchRow { id: number; batch: string; path: string; seq: number; content: string | null; deleted: number; message: string | null }

const mode = process.argv[2] ?? "apply";
const env = process.env;
const accountId = env.CLOUDFLARE_ACCOUNT_ID, apiToken = env.CLOUDFLARE_API_TOKEN;
let databaseId = env.D1_DATABASE_ID;
if (!databaseId) databaseId = (await Bun.file("wrangler.toml").text()).match(/database_id\s*=\s*"([^"]+)"/)?.[1];
if (!accountId || !apiToken || !databaseId) { console.error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN und D1_DATABASE_ID (oder wrangler.toml) werden benötigt."); process.exit(1); }
const db = new D1HttpDb({ accountId, databaseId, apiToken, baseUrl: env.D1_BASE_URL });
const root = resolve(".");
const stateFile = resolve(".sync-state.json");
const output = (k: string, v: string) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`); };

if (mode === "mark") {
  if (!existsSync(stateFile)) { console.log("Nichts zu markieren."); process.exit(0); }
  const { maxId } = JSON.parse(await Bun.file(stateFile).text()) as { maxId: number };
  const r = await db.run("UPDATE deploy_patches SET applied_at = ? WHERE applied_at IS NULL AND id <= ?", [new Date().toISOString(), maxId]);
  rmSync(stateFile);
  console.log(`${r.changes} Zeilen als angewendet markiert (bis id ${maxId}).`);
  process.exit(0);
}

const rows = await db.all<PatchRow>("SELECT id, batch, path, seq, content, deleted, message FROM deploy_patches WHERE applied_at IS NULL ORDER BY id");
if (!rows.length) { console.log("Keine ausstehenden Änderungen."); output("changed", "false"); process.exit(0); }

// Later batches win for the same path; chunks of one file are concatenated in seq order.
const files = new Map<string, { chunks: Map<number, string>; deleted: boolean; batch: string }>();
const messages: string[] = [];
for (const r of rows) {
  if (r.path.includes("..") || r.path.startsWith("/") || r.path.startsWith(".git/")) { console.error(`Unzulässiger Pfad: ${r.path}`); process.exit(1); }
  if (r.message && !messages.includes(r.message)) messages.push(r.message);
  let f = files.get(r.path);
  if (!f || f.batch !== r.batch) { f = { chunks: new Map(), deleted: false, batch: r.batch }; files.set(r.path, f); }
  if (r.deleted) f.deleted = true; else if (r.content != null) f.chunks.set(r.seq, r.content);
}
let written = 0, deleted = 0;
for (const [path, f] of files) {
  const abs = resolve(root, path);
  if (f.deleted) { if (existsSync(abs)) { rmSync(abs); deleted++; console.log(`− ${path}`); } continue; }
  const b64 = [...f.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("");
  const bytes = gunzipSync(Buffer.from(b64, "base64"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  written++; console.log(`+ ${path} (${bytes.length} B)`);
}
const maxId = Math.max(...rows.map((r) => r.id));
writeFileSync(stateFile, JSON.stringify({ maxId }));
const message = messages.join("\n\n") || `Sync: ${written} Dateien aktualisiert, ${deleted} gelöscht`;
writeFileSync(resolve(env.RUNNER_TEMP ?? ".", "sync-message.txt"), `${message}\n\nSync aus dem Arbeitsbereich (deploy_patches bis id ${maxId}).\n`);
output("changed", "true"); output("max_id", String(maxId));
console.log(`${written} Dateien geschrieben, ${deleted} gelöscht · ${rows.length} Zeilen · Commit: ${message.split("\n")[0]}`);
