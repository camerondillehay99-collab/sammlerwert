/**
 * Stripe subscriptions without the SDK (plain REST + webhook signature verification).
 * Plans: free → "sammler" (monthly) → "pro" (monthly). Price ids come from env.
 */
import type { SqlDb } from "../db/adapter.ts";
import { config } from "../config.ts";
import { ApiError } from "../http.ts";

export function stripeConfigured() { return !!config.stripe.secretKey; }

async function stripe<T>(path: string, params: Record<string, string>, method = "POST"): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${config.stripe.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? new URLSearchParams(params) : undefined,
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new ApiError(502, `Stripe: ${json.error?.message ?? res.status}`, "stripe_error");
  return json;
}

export async function createCheckoutSession(db: SqlDb, user: { id: number; email: string }, plan: "sammler" | "pro"): Promise<string> {
  if (!stripeConfigured()) throw new ApiError(503, "Zahlungen sind noch nicht konfiguriert.", "billing_disabled");
  const price = plan === "pro" ? config.stripe.pricePro : config.stripe.priceSammler;
  if (!price) throw new ApiError(503, "Preis-ID fehlt in der Konfiguration.", "billing_disabled");
  let customer = (await db.first<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM users WHERE id = ?", [user.id]))?.stripe_customer_id;
  if (!customer) {
    const c = await stripe<{ id: string }>("/customers", { email: user.email, "metadata[user_id]": String(user.id) });
    customer = c.id;
    await db.run("UPDATE users SET stripe_customer_id = ? WHERE id = ?", [customer, user.id]);
  }
  const session = await stripe<{ url: string }>("/checkout/sessions", {
    mode: "subscription", customer, "line_items[0][price]": price, "line_items[0][quantity]": "1",
    success_url: `${config.brand.domain}/einstellungen?checkout=success`, cancel_url: `${config.brand.domain}/einstellungen?checkout=cancel`,
    "subscription_data[metadata][user_id]": String(user.id), "subscription_data[metadata][plan]": plan,
    locale: "de", allow_promotion_codes: "true", "automatic_tax[enabled]": "true", "customer_update[address]": "auto",
  });
  return session.url;
}

export async function createPortalSession(db: SqlDb, userId: number): Promise<string> {
  const customer = (await db.first<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM users WHERE id = ?", [userId]))?.stripe_customer_id;
  if (!customer) throw new ApiError(400, "Kein Abonnement vorhanden.", "no_subscription");
  const s = await stripe<{ url: string }>("/billing_portal/sessions", { customer, return_url: `${config.brand.domain}/einstellungen` });
  return s.url;
}

/** Verify `Stripe-Signature` (v1, HMAC-SHA256 over "t.payload"), 5-minute tolerance. */
export async function verifyWebhook(payload: string, sigHeader: string | null, secret = config.stripe.webhookSecret): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, v1);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface SubscriptionObj { id: string; customer: string; status: string; metadata?: { user_id?: string; plan?: string }; current_period_end?: number; items?: { data: Array<{ price: { id: string } }> } }

export async function applySubscriptionEvent(db: SqlDb, type: string, obj: SubscriptionObj) {
  const userId = Number(obj.metadata?.user_id) || (await db.first<{ id: number }>("SELECT id FROM users WHERE stripe_customer_id = ?", [obj.customer]))?.id;
  if (!userId) return;
  const priceId = obj.items?.data[0]?.price.id;
  const plan = obj.metadata?.plan ?? (priceId === config.stripe.pricePro ? "pro" : "sammler");
  const active = ["active", "trialing", "past_due"].includes(obj.status) && type !== "customer.subscription.deleted";
  await db.run("UPDATE users SET plan = ?, plan_status = ?, stripe_subscription_id = ?, plan_renews_at = ? WHERE id = ?",
    [active ? plan : "free", obj.status, obj.id, obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null, userId]);
}
