#!/usr/bin/env bun
/**
 * Collects every tr("…") source string from the web client into shared/i18n-keys.json.
 * The server translates this list for machine-translated languages; a test checks that the English
 * dictionary covers it. Run after changing UI text:  bun run scripts/i18n-extract.ts
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../web/src/", import.meta.url).pathname;
const keys = new Set<string>();
function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/\btr\("((?:[^"\\]|\\.)*)"/g)) { const k = (JSON.parse(`"${m[1]}"`) as string).trim(); if (k) keys.add(k); }
  }
}
walk(root);
const sorted = [...keys].sort((a, b) => a.localeCompare(b, "de"));
writeFileSync(new URL("../shared/i18n-keys.json", import.meta.url), JSON.stringify(sorted, null, 1) + "\n");
console.log(`${sorted.length} UI strings → shared/i18n-keys.json`);
