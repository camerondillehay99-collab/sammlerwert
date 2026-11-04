/**
 * Account routes. Two-factor authentication (TOTP) is mandatory for new accounts:
 *   register → pending session → /2fa/setup (secret + otpauth link) → /2fa/enable (first code) → recovery codes, full session.
 *   login   → user with 2FA: pending session → /2fa/verify (code or recovery code) → full session.
 *             user without 2FA (created before the rule): full session, the app asks them to set it up.
 */
import { add } from "./router.ts";
import { config } from "../config.ts";
import { ApiError, badRequest, json, readJson, str, unauthorized } from "../http.ts";
import { completeMfa, createSession, destroySession, login, register, requireUser, sessionState, type AuthUser } from "../auth.ts";
import { consumeRecoveryCode, generateRecoveryCodes, generateSecret, hashRecoveryCodes, otpauthUrl, verifyTotp } from "../totp.ts";
import type { AuthResponse } from "../../shared/types.ts";

const pub = (u: AuthUser | null) => u;

// Brute-force guard per session: 8 wrong codes → the pending session is thrown away (user logs in again).
const attempts = new Map<string, number>();
function strike(sessionId: string): boolean { const n = (attempts.get(sessionId) ?? 0) + 1; attempts.set(sessionId, n); return n >= 8; }

add("POST", "/api/auth/register", async (req, _p, db) => {
  const b = await readJson<{ email?: string; password?: string; name?: string }>(req);
  const user = await register(db, String(b.email ?? ""), String(b.password ?? ""), str(b.name, 80));
  const s = await createSession(db, user.id, req.headers.get("user-agent"), true);
  const body: AuthResponse = { user: null, mfa: "setup", email: user.email };
  return json(body, 201, { "set-cookie": s.setCookie });
});

add("POST", "/api/auth/login", async (req, _p, db) => {
  const b = await readJson<{ email?: string; password?: string }>(req);
  const user = await login(db, String(b.email ?? ""), String(b.password ?? ""));
  const s = await createSession(db, user.id, req.headers.get("user-agent"), user.totpEnabled);
  const body: AuthResponse = user.totpEnabled ? { user: null, mfa: "verify", email: user.email } : { user: pub(user), mfa: null };
  return json(body, 200, { "set-cookie": s.setCookie });
});

add("POST", "/api/auth/logout", async (req, _p, db) => json({ ok: true }, 200, { "set-cookie": await destroySession(db, req) }));

add("GET", "/api/auth/me", async (req, _p, db) => {
  const s = await sessionState(db, req);
  const body: AuthResponse = !s ? { user: null, mfa: null } : s.pending ? { user: null, mfa: s.user.totpEnabled ? "verify" : "setup", email: s.user.email } : { user: pub(s.user), mfa: null };
  return json(body);
});

add("PATCH", "/api/auth/me", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<{ name?: string; locale?: string }>(req);
  await db.run("UPDATE users SET name = COALESCE(?, name), locale = COALESCE(?, locale) WHERE id = ?", [str(b.name, 80), b.locale && /^[a-z]{2}$/.test(b.locale) ? b.locale : null, u.id]);
  return json({ user: (await sessionState(db, req))?.user ?? null });
});

/** Start (or restart) 2FA setup. Allowed for pending sessions (registration) and full sessions (older accounts, re-setup with current code). */
add("POST", "/api/auth/2fa/setup", async (req, _p, db) => {
  const s = await sessionState(db, req);
  if (!s) throw unauthorized();
  const b = await readJson<{ code?: string }>(req).catch(() => ({} as { code?: string }));
  if (s.user.totpEnabled) {
    const row = await db.first<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE id = ?", [s.user.id]);
    if (!row?.totp_secret || !(await verifyTotp(row.totp_secret, String(b.code ?? "")))) throw badRequest("Zum Zurücksetzen bitte den aktuellen Code aus deiner Authenticator-App eingeben.", "code_required");
  }
  const secret = generateSecret();
  await db.run("UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?", [secret, s.user.id]);
  return json({ secret, otpauth: otpauthUrl(config.brand.name, s.user.email, secret), email: s.user.email });
});

/** Confirm the first code → 2FA active, recovery codes issued, session promoted. */
add("POST", "/api/auth/2fa/enable", async (req, _p, db) => {
  const s = await sessionState(db, req);
  if (!s) throw unauthorized();
  const b = await readJson<{ code?: string }>(req);
  const row = await db.first<{ totp_secret: string | null }>("SELECT totp_secret FROM users WHERE id = ?", [s.user.id]);
  if (!row?.totp_secret) throw badRequest("Bitte zuerst die Einrichtung starten.", "setup_required");
  if (!(await verifyTotp(row.totp_secret, String(b.code ?? "")))) {
    if (strike(s.sessionId) && s.pending) { await destroySession(db, req); throw new ApiError(401, "Zu viele Fehlversuche – bitte neu anmelden.", "too_many_attempts"); }
    throw badRequest("Der Code stimmt nicht. Prüfe die Uhrzeit deines Geräts und versuche es mit dem nächsten Code.", "invalid_code");
  }
  const codes = generateRecoveryCodes();
  await db.run("UPDATE users SET totp_enabled = 1, totp_enabled_at = ?, recovery_codes = ? WHERE id = ?", [new Date().toISOString(), JSON.stringify(await hashRecoveryCodes(codes)), s.user.id]);
  attempts.delete(s.sessionId);
  const setCookie = await completeMfa(db, s.sessionId);
  const user = (await sessionState(db, req))!.user;
  return json({ user: { ...user, totpEnabled: true }, recoveryCodes: codes }, 200, { "set-cookie": setCookie });
});

/** Second step of login: TOTP code or a recovery code. */
add("POST", "/api/auth/2fa/verify", async (req, _p, db) => {
  const s = await sessionState(db, req);
  if (!s) throw unauthorized("Die Anmeldung ist abgelaufen – bitte neu anmelden.");
  if (!s.pending) return json({ user: pub(s.user) });
  const b = await readJson<{ code?: string }>(req);
  const code = String(b.code ?? "").trim();
  const row = await db.first<{ totp_secret: string | null; recovery_codes: string | null }>("SELECT totp_secret, recovery_codes FROM users WHERE id = ?", [s.user.id]);
  let ok = !!row?.totp_secret && (await verifyTotp(row.totp_secret, code));
  let usedRecovery = false;
  if (!ok && row?.recovery_codes && code.replace(/[^a-z0-9]/gi, "").length === 10) {
    const left = await consumeRecoveryCode(JSON.parse(row.recovery_codes) as string[], code);
    if (left) { ok = true; usedRecovery = true; await db.run("UPDATE users SET recovery_codes = ? WHERE id = ?", [JSON.stringify(left), s.user.id]); }
  }
  if (!ok) {
    if (strike(s.sessionId)) { await destroySession(db, req); throw new ApiError(401, "Zu viele Fehlversuche – bitte neu anmelden.", "too_many_attempts"); }
    throw badRequest("Der Code stimmt nicht.", "invalid_code");
  }
  attempts.delete(s.sessionId);
  const setCookie = await completeMfa(db, s.sessionId);
  const left = usedRecovery ? (JSON.parse((await db.first<{ recovery_codes: string }>("SELECT recovery_codes FROM users WHERE id = ?", [s.user.id]))!.recovery_codes) as string[]).length : null;
  return json({ user: pub(s.user), usedRecovery, recoveryCodesLeft: left }, 200, { "set-cookie": setCookie });
});

/** Fresh recovery codes (invalidates the old ones) – needs the current TOTP code. */
add("POST", "/api/auth/2fa/recovery", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const b = await readJson<{ code?: string }>(req);
  const row = await db.first<{ totp_secret: string | null }>("SELECT totp_secret FROM users WHERE id = ? AND totp_enabled = 1", [u.id]);
  if (!row?.totp_secret || !(await verifyTotp(row.totp_secret, String(b.code ?? "")))) throw badRequest("Der Code stimmt nicht.", "invalid_code");
  const codes = generateRecoveryCodes();
  await db.run("UPDATE users SET recovery_codes = ? WHERE id = ?", [JSON.stringify(await hashRecoveryCodes(codes)), u.id]);
  return json({ recoveryCodes: codes });
});

add("GET", "/api/auth/2fa/status", async (req, _p, db) => {
  const u = await requireUser(db, req);
  const row = await db.first<{ totp_enabled: number; totp_enabled_at: string | null; recovery_codes: string | null }>("SELECT totp_enabled, totp_enabled_at, recovery_codes FROM users WHERE id = ?", [u.id]);
  return json({ enabled: !!row?.totp_enabled, enabledAt: row?.totp_enabled_at ?? null, recoveryCodesLeft: row?.recovery_codes ? (JSON.parse(row.recovery_codes) as string[]).length : 0 });
});

add("GET", "/api/auth/sessions", async (req, _p, db) => {
  const u = await requireUser(db, req);
  return json({ sessions: await db.all("SELECT id, created_at, expires_at, user_agent FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY created_at DESC LIMIT 20", [u.id]) });
});
add("POST", "/api/auth/sessions/revoke-others", async (req, _p, db) => {
  const s = await sessionState(db, req);
  if (!s || s.pending) throw unauthorized();
  await db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", [s.user.id, s.sessionId]);
  return json({ ok: true });
});
