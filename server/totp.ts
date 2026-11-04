/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s) and single-use recovery codes.
 * WebCrypto only – runs identically on Cloudflare Workers and Bun. Compatible with Google Authenticator, Aegis, 1Password, Authy …
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = new Uint8Array(new ArrayBuffer(out.length));
  buf.set(out);
  return buf;
}

export function generateSecret(): string { return base32Encode(crypto.getRandomValues(new Uint8Array(20))); }

export async function hotp(secret: string, counter: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export async function totp(secret: string, at = Date.now(), period = 30): Promise<string> {
  return hotp(secret, Math.floor(at / 1000 / period));
}

/** Accepts the current code and one step either side (clock drift). */
export async function verifyTotp(secret: string, code: string, at = Date.now(), window = 1): Promise<boolean> {
  const c = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(at / 1000 / 30);
  for (let d = -window; d <= window; d++) if (timingSafeEqual(await hotp(secret, step + d), c)) return true;
  return false;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- recovery codes: 8 × "xxxxx-xxxxx", stored as SHA-256 hex, each usable once ----------
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i
export function generateRecoveryCodes(n = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = crypto.getRandomValues(new Uint8Array(10));
    const s = [...r].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    out.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const normalizeRecovery = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> { return Promise.all(codes.map((c) => sha256Hex(normalizeRecovery(c)))); }

/** Returns the remaining hashes when the code matched, null otherwise. */
export async function consumeRecoveryCode(hashes: string[], code: string): Promise<string[] | null> {
  const h = await sha256Hex(normalizeRecovery(code));
  const i = hashes.findIndex((x) => timingSafeEqual(x, h));
  if (i < 0) return null;
  return [...hashes.slice(0, i), ...hashes.slice(i + 1)];
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
