// Central configuration. Built from an env map so it works with process.env (Bun) and Worker bindings.
export type EnvMap = Record<string, string | undefined>;

const bool = (v: string | undefined, d = false): boolean => (v == null ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);

export function buildConfig(e: EnvMap) {
  const env = (k: string, d = ""): string => e[k] ?? d;
  const isProd = env("NODE_ENV") === "production" || env("ENVIRONMENT") === "production";
  return {
    brand: {
      name: env("BRAND_NAME", "Sammlerwert"),
      tagline: env("BRAND_TAGLINE", "Der Marktwert deiner deutschen Pokémon-Karten."),
      domain: env("PUBLIC_URL", "http://localhost:4180"),
    },
    port: Number(env("PORT", "4180")),
    host: env("HOST", "0.0.0.0"),
    isProd,
    dataDir: env("DATA_DIR", "./data"),
    dbPath: env("DB_PATH", "./data/sammlerwert.db"),
    rawDir: env("RAW_DIR", "./data/raw"),
    uploadsDir: env("UPLOADS_DIR", "./data/uploads"),
    webDir: env("WEB_DIR", "./web/public"),
    sessionDays: Number(env("SESSION_DAYS", "30")),
    cookieSecure: bool(e.COOKIE_SECURE, isProd),
    adminEmails: list(e.ADMIN_EMAILS, "").map((s) => s.toLowerCase()),
    ingest: {
      cardmarketBase: env("CARDMARKET_DOWNLOAD_BASE", "https://downloads.s3.cardmarket.com/productCatalog"),
      cardmarketGameId: Number(env("CARDMARKET_GAME_ID", "6")), // 6 = Pokémon
      tcgdexBase: env("TCGDEX_BASE", "https://api.tcgdex.net/v2"),
      detailSets: list(e.TCGDEX_DETAIL_SETS, "sv*,me*,swsh12.5,swsh7,base1"),
      userAgent: env("INGEST_USER_AGENT", "Sammlerwert/0.1 (+https://sammlerwert.de)"),
      requestDelayMs: Number(env("INGEST_DELAY_MS", "80")),
      dailyHourUtc: Number(env("INGEST_HOUR_UTC", "5")),
      /** cards fetched per catalog-completion run (Workers cron: keep well under the 15-minute wall time) */
      completionBatch: Number(env("CATALOG_COMPLETION_BATCH", "600")),
    },
    ebay: {
      clientId: env("EBAY_CLIENT_ID"),
      clientSecret: env("EBAY_CLIENT_SECRET"),
      marketplace: env("EBAY_MARKETPLACE", "EBAY_DE"),
      env: env("EBAY_ENV", "production") as "production" | "sandbox",
      /** null = unknown (probe the Marketplace Insights scope); an empty variable counts as unset, not as "off" */
      insightsEnabled: !e.EBAY_INSIGHTS_ENABLED?.trim() ? null : bool(e.EBAY_INSIGHTS_ENABLED, true),
      maxCardsPerRun: Number(env("EBAY_MAX_CARDS_PER_RUN", "700")),
    },
    comps: {
      /** compsapi.com key: real eBay sold items (3 years) for the Sales page. Nightly sweep in GitHub Actions; on-demand refresh in the Worker when set there too. */
      apiKey: env("COMPSAPI_KEY").trim().replace(/^bearer\s+/i, ""),
      /** requests a nightly run may spend (plans: Growth 25 000 / month ≈ 800 / day, Pro 100 000 ≈ 3 200 / day) */
      dailyRequests: Number(env("COMPS_DAILY_REQUESTS", "800")),
      /** requests per day for card-page refreshes by logged-in users */
      onDemandDailyRequests: Number(env("COMPS_ONDEMAND_REQUESTS", "150")),
      /** eBay sites swept, in order (DE = eBay.de in EUR, US = eBay.com in USD) */
      sites: list(e.COMPS_SITES, "DE,US").map((s) => s.toUpperCase()),
      /** how far the first (backfill) sweep of a card looks back; paid plans allow up to 1095 days */
      historyDays: Number(env("COMPS_HISTORY_DAYS", "1095")),
    },
    psa: {
      /** PSA Public API token (psacard.com → Public API). Enables certificate lookups for slabs and PSA list imports. */
      token: env("PSA_API_TOKEN").trim().replace(/^bearer\s+/i, ""),
      base: env("PSA_API_BASE", "https://api.psacard.com/publicapi"),
    },
    stripe: {
      secretKey: env("STRIPE_SECRET_KEY"),
      webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
      priceSammler: env("STRIPE_PRICE_SAMMLER"),
      pricePro: env("STRIPE_PRICE_PRO"),
    },
    limits: {
      free: { items: 50, collections: 3, history: false, alerts: 0, exports: false, scansPerDay: 30 },
      sammler: { items: 2500, collections: 15, history: true, alerts: 25, exports: true, scansPerDay: 1000 },
      pro: { items: Infinity, collections: Infinity, history: true, alerts: Infinity, exports: true, scansPerDay: Infinity },
    },
  };
}

export type Config = ReturnType<typeof buildConfig>;

const processEnv: EnvMap = typeof process !== "undefined" && process.env ? (process.env as EnvMap) : {};
export let config: Config = buildConfig(processEnv);

/** Replace the active configuration (Workers call this with their bindings on every invocation – cheap). */
export function applyEnv(e: EnvMap) { config = buildConfig({ ...processEnv, ...e }); }
