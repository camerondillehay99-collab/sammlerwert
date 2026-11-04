#!/usr/bin/env bun
// bun run scripts/make-admin.ts you@example.com   (local SQLite; on Cloudflare set ADMIN_EMAILS in wrangler.toml instead)
import { config } from "../server/config.ts";
import { openBunDb } from "../server/db/bun-sqlite.ts";
const email = process.argv[2]?.toLowerCase();
if (!email) { console.error("E-Mail fehlt"); process.exit(1); }
const r = await (await openBunDb(config.dbPath)).run("UPDATE users SET is_admin = 1 WHERE email = ?", [email]);
console.log(r.changes ? `${email} ist jetzt Admin.` : `Kein Konto mit ${email} gefunden.`);
