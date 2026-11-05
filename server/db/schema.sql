-- Sammlerwert schema (SQLite). Kept Postgres-portable: no SQLite-only types beyond TEXT/INTEGER/REAL.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- Catalog ----------
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  name_de TEXT,
  name_en TEXT,
  logo TEXT
);

CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,
  series_id TEXT REFERENCES series(id),
  name_de TEXT,
  name_en TEXT,
  abbreviation TEXT,
  release_date TEXT,
  card_count_official INTEGER,
  card_count_total INTEGER,
  logo TEXT,
  symbol TEXT,
  cm_expansion_id INTEGER,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sets_release ON sets(release_date);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,               -- tcgdex id e.g. sv03.5-199
  set_id TEXT NOT NULL REFERENCES sets(id),
  local_id TEXT NOT NULL,
  name_de TEXT,
  name_en TEXT,
  category TEXT,
  rarity TEXT,
  image TEXT,                        -- tcgdex asset base (without quality/extension)
  image_en TEXT,                     -- English print as fallback when no German scan exists
  hp INTEGER,
  types TEXT,                        -- JSON array
  dex_ids TEXT,                      -- JSON array
  illustrator TEXT,
  variants TEXT,                     -- JSON object {normal,reverse,holo,firstEdition}
  detail_loaded INTEGER NOT NULL DEFAULT 0,
  cm_product_id INTEGER,
  cm_match_method TEXT,
  cm_match_confidence REAL,
  tcgp_product_id INTEGER,           -- TCGplayer product (English print) – price history source
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(set_id);

CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  card_id UNINDEXED, name_de, name_en, set_name_de, set_name_en, local_id, tokenize = 'unicode61 remove_diacritics 2'
);

-- ---------- Cardmarket ----------
CREATE TABLE IF NOT EXISTS cm_products (
  id_product INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  id_category INTEGER,
  category_name TEXT,
  id_expansion INTEGER,
  id_metacard INTEGER,
  date_added TEXT,
  is_single INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_cm_products_exp ON cm_products(id_expansion);
CREATE INDEX IF NOT EXISTS idx_cm_products_name ON cm_products(name);

CREATE TABLE IF NOT EXISTS cm_expansions (
  id_expansion INTEGER PRIMARY KEY,
  name TEXT,
  abbreviation TEXT,
  set_id TEXT REFERENCES sets(id)
);

-- Daily snapshots of the public price guide. All languages & conditions mixed (Cardmarket semantics).
CREATE TABLE IF NOT EXISTS cm_price_guide (
  id_product INTEGER NOT NULL,
  date TEXT NOT NULL,
  avg REAL, low REAL, trend REAL, avg1 REAL, avg7 REAL, avg30 REAL,
  foil_avg REAL, foil_low REAL, foil_trend REAL, foil_avg1 REAL, foil_avg7 REAL, foil_avg30 REAL,
  PRIMARY KEY (id_product, date)
);
CREATE INDEX IF NOT EXISTS idx_cm_guide_date ON cm_price_guide(date);

-- ---------- Sales (the German-language signal) ----------
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT REFERENCES cards(id),
  language TEXT NOT NULL DEFAULT 'de',
  variant TEXT NOT NULL DEFAULT 'normal',
  condition TEXT,
  grading_company TEXT,
  grade REAL,
  price_eur REAL NOT NULL,
  shipping_eur REAL,
  sold_at TEXT NOT NULL,
  source TEXT NOT NULL,              -- ebay_de | ebay | cardmarket | user | import
  source_ref TEXT,                   -- external id (dedupe)
  title TEXT,
  url TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  reporter_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_sales_card ON sales(card_id, language, variant, sold_at);

-- Listings observed (active offers) – weaker signal than sales, still useful for floors.
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT REFERENCES cards(id),
  language TEXT NOT NULL DEFAULT 'de',
  variant TEXT NOT NULL DEFAULT 'normal',
  condition TEXT,
  price_eur REAL NOT NULL,
  seen_at TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  title TEXT,
  url TEXT,
  UNIQUE (source, source_ref, seen_at)
);
CREATE INDEX IF NOT EXISTS idx_listings_card ON listings(card_id, language, seen_at);

-- ---------- Computed prices ----------
-- Quotes are computed on read (server/pricing/quotes.ts) from cm_price_guide × language_factors + sales/listings.
-- Nothing per card is pre-stored: keeps D1 free-tier writes tiny and prices always fresh.

-- Language premium per set (German vs. Cardmarket mixed guide), learned from paired data.
CREATE TABLE IF NOT EXISTS language_factors (
  set_id TEXT NOT NULL,
  language TEXT NOT NULL,
  factor REAL NOT NULL,
  n INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (set_id, language)
);

-- ---------- Users & collections ----------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  locale TEXT NOT NULL DEFAULT 'de',
  plan TEXT NOT NULL DEFAULT 'free',
  plan_status TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan_renews_at TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  totp_secret TEXT,                      -- base32, set during 2FA setup (pending until totp_enabled = 1)
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_enabled_at TEXT,
  recovery_codes TEXT                    -- JSON array of SHA-256 hashes, each single-use
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  mfa_pending INTEGER NOT NULL DEFAULT 0 -- 1 = password accepted, second factor (or its setup) still missing
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  share_token TEXT,                      -- public read-only link (/s/<token>), null = private
  description TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id),
  language TEXT NOT NULL DEFAULT 'de',
  variant TEXT NOT NULL DEFAULT 'normal',
  condition TEXT NOT NULL DEFAULT 'NM',
  grading_company TEXT,
  grade REAL,
  cert_no TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  purchase_price_eur REAL,
  purchased_at TEXT,
  notes TEXT,
  image_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  source TEXT                            -- manual | scan | import:<source> | psa
);
CREATE INDEX IF NOT EXISTS idx_items_collection ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_items_card ON collection_items(card_id);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  total_value REAL NOT NULL,
  total_cost REAL NOT NULL,
  item_count INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id),
  language TEXT NOT NULL DEFAULT 'de',
  target_price REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, card_id, language)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT
);

-- Scanner log: what the vision model read and which card we picked (quality tracking, daily limits).
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  created_at TEXT NOT NULL,
  facts TEXT,
  card_id TEXT,
  confidence REAL,
  ms INTEGER
);

-- Per-card bookkeeping for the eBay rotation (see server/ingest/ebay.ts dueCards).
CREATE TABLE IF NOT EXISTS ebay_refresh (
  card_id TEXT PRIMARY KEY REFERENCES cards(id),
  last_at TEXT NOT NULL,
  listings INTEGER NOT NULL DEFAULT 0,
  sales INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

-- Code changes queued from the development workspace; `scripts/sync-from-d1.ts` (GitHub Actions) turns them into commits.
-- One row per file chunk (gzip + base64, ≤ 60 kB so a row fits D1's statement limit); `deleted` removes the path.
CREATE TABLE IF NOT EXISTS deploy_patches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT NOT NULL,
  path TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

-- PSA certificate lookups (public PSA API), cached so a cert is fetched once.
CREATE TABLE IF NOT EXISTS psa_certs (
  cert_no TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  card_id TEXT
);

-- Machine-translated UI strings for languages beyond German/English (see server/i18n.ts)
CREATE TABLE IF NOT EXISTS ui_translations (
  lang TEXT NOT NULL,
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (lang, key)
);

-- ---------- Price history backbone ----------
-- TCGplayer groups (sets) from TCGCSV, linked to our sets.
CREATE TABLE IF NOT EXISTS tcgp_groups (
  group_id INTEGER PRIMARY KEY,
  set_id TEXT,
  name TEXT,
  abbreviation TEXT,
  published_on TEXT,
  products INTEGER,
  matched INTEGER,
  updated_at TEXT
);
-- One packed daily series per card/source/variant: points = "YYYYMMDD:price;…" ascending (source currency).
CREATE TABLE IF NOT EXISTS price_series (
  card_id TEXT NOT NULL,
  source TEXT NOT NULL,              -- tcgplayer | …
  variant TEXT NOT NULL,             -- normal | holo | reverse | firstEdition
  currency TEXT NOT NULL DEFAULT 'USD',
  points TEXT NOT NULL DEFAULT '',
  first_date TEXT,
  last_date TEXT,
  n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (card_id, source, variant)
);
