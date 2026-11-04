import type { SqlDb } from "./db/adapter.ts";
import type { Plan, User } from "../shared/types.ts";
import { config } from "./config.ts";
import { cookie, parseCookies, badRequest, unauthorized } from "./http.ts";
import { nowIso } from "./db/index.ts";

export const SESSION_COOKIE = "sw_session";

interface UserRow { id: number; email: string; name: string | null; plan: string; plan_status: string | null; locale: string; created_at: string; is_admin: number }
export type AuthUser = User & { isAdmin: boolean };

export function toUser(r: UserRow): AuthUser {
  return { id: r.id, email: r.email, name: r.name, plan: r.plan as Plan, planStatus: r.plan_status, locale: r.locale, createdAt: r.created_at, isAdmin: !!r.is_admin };
}

// ---------- password hashing: PBKDF2-SHA256 via WebCrypto (Workers cap iterations at 100k) ----------
const PBKDF2_ITER = 100_000;
const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16)), iter = PBKDF2_ITER): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterS, saltB, hashB] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterS || !saltB || !hashB) return false;
  const again = await hashPassword(password, unb64(saltB), Number(iterS));
  const a = again.split("$")[3]!, b = hashB;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function register(db: SqlDb, email: string, password: string, name: string | null): Promise<AuthUser> {
  email = email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest("Bitte eine gültige E-Mail-Adresse angeben.", "invalid_email");
  if (password.length < 8) throw badRequest("Das Passwort muss mindestens 8 Zeichen lang sein.", "weak_password");
  if (await db.first("SELECT 1 FROM users WHERE email = ?", [email])) throw badRequest("Diese E-Mail ist bereits registriert.", "email_taken");
  const hash = await hashPassword(password);
  const isAdmin = config.adminEmails.includes(email) ? 1 : 0;
  const res = await db.run("INSERT INTO users(email, password_hash, name, is_admin) VALUES (?, ?, ?, ?)", [email, hash, name, isAdmin]);
  const userId = res.lastInsertRowid;
  await db.run("INSERT INTO collections(user_id, name, is_default) VALUES (?, 'Meine Sammlung', 1)", [userId]);
  return (await getUserById(db, userId))!;
}

export async function login(db: SqlDb, email: string, password: string): Promise<AuthUser> {
  email = email.trim().toLowerCase();
  const row = await db.first<UserRow & { password_hash: string }>("SELECT * FROM users WHERE email = ?", [email]);
  const ok = row ? await verifyPassword(password, row.password_hash) : (await hashPassword(password), false); // constant-ish time
  if (!row || !ok) throw unauthorized("E-Mail oder Passwort ist falsch.");
  return toUser(row);
}

export async function createSession(db: SqlDb, userId: number, userAgent: string | null): Promise<{ id: string; setCookie: string }> {
  const id = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000).toISOString();
  await db.run("INSERT INTO sessions(id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)", [id, userId, expires, userAgent]);
  return { id, setCookie: cookie(SESSION_COOKIE, id, { maxAge: config.sessionDays * 86_400, secure: config.cookieSecure }) };
}

export async function destroySession(db: SqlDb, req: Request): Promise<string> {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) await db.run("DELETE FROM sessions WHERE id = ?", [sid]);
  return cookie(SESSION_COOKIE, "", { maxAge: 0, secure: config.cookieSecure });
}

export async function getUserById(db: SqlDb, id: number): Promise<AuthUser | null> {
  const row = await db.first<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return row ? toUser(row) : null;
}

export async function currentUser(db: SqlDb, req: Request): Promise<AuthUser | null> {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = await db.first<UserRow & { expires_at: string }>("SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?", [sid]);
  if (!row) return null;
  if (row.expires_at < nowIso()) { await db.run("DELETE FROM sessions WHERE id = ?", [sid]); return null; }
  return toUser(row);
}

export async function requireUser(db: SqlDb, req: Request): Promise<AuthUser> {
  const u = await currentUser(db, req);
  if (!u) throw unauthorized();
  return u;
}

export function planLimits(plan: Plan) { return config.limits[plan] ?? config.limits.free; }
