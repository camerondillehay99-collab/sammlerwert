// Shared domain types used by server and web client.

export type Language = "de" | "en" | "jp" | "fr" | "it" | "es" | "pt" | "other";
export type Variant = "normal" | "reverse" | "holo" | "firstEdition" | "promo";
export type Condition = "MT" | "NM" | "EX" | "GD" | "LP" | "PL" | "PO";
export type GradingCompany = "PSA" | "BGS" | "CGC" | "GSG" | "AP" | "TAG" | "ACE" | "OTHER";
export type SaleSource = "ebay_de" | "ebay" | "cardmarket" | "user" | "import";
export type Plan = "free" | "sammler" | "pro";

export const LANGUAGE_LABELS: Record<Language, string> = {
  de: "Deutsch", en: "Englisch", jp: "Japanisch", fr: "Französisch", it: "Italienisch",
  es: "Spanisch", pt: "Portugiesisch", other: "Andere",
};
export const CONDITION_LABELS: Record<Condition, string> = {
  MT: "Mint", NM: "Near Mint", EX: "Excellent", GD: "Good", LP: "Light Played", PL: "Played", PO: "Poor",
};
export const VARIANT_LABELS: Record<Variant, string> = {
  normal: "Normal", reverse: "Reverse Holo", holo: "Holo", firstEdition: "1. Edition", promo: "Promo",
};

export interface SetSummary {
  id: string;
  seriesId: string | null;
  seriesName: string | null;
  nameDe: string | null;
  nameEn: string | null;
  abbreviation: string | null;
  releaseDate: string | null;
  cardCountOfficial: number | null;
  cardCountTotal: number | null;
  logo: string | null;
  symbol: string | null;
  cardsLoaded: number;
}

export interface CardSummary {
  id: string;
  setId: string;
  setNameDe: string | null;
  setNameEn: string | null;
  localId: string;
  nameDe: string | null;
  nameEn: string | null;
  rarity: string | null;
  category: string | null;
  image: string | null;
  imageEn: string | null;
  /** Primary German market value (EUR) for the default variant, if known */
  valueDe: number | null;
  valueEn: number | null;
  confidenceDe: number | null;
  trend30: number | null;
}

export interface PriceQuote {
  cardId: string;
  language: Language;
  variant: Variant;
  value: number | null;      // EUR market value estimate
  low: number | null;
  high: number | null;
  confidence: number;        // 0..1
  nSales30d: number;
  nSales90d: number;
  trend7: number | null;     // relative change, e.g. 0.05 = +5 %
  trend30: number | null;
  sources: Record<string, number>; // weight by source
  method: string;            // human-readable explanation key
  computedAt: string;
}

export interface CardDetail extends CardSummary {
  hp: number | null;
  types: string[];
  dexIds: number[];
  illustrator: string | null;
  variants: Record<string, boolean>;
  cmProductId: number | null;
  cmUrl: string | null;
  cmMatchMethod: string | null;
  cmMatchConfidence: number | null;
  prices: PriceQuote[];
  guide: CardmarketGuidePoint | null;
  history: PricePoint[];
  /** full daily series per source/variant (TCGplayer since 2024, Cardmarket + Sammlerwert since launch) */
  series: PriceSeries[];
  /** TCGplayer product id (English print) when matched */
  tcgpProductId: number | null;
  sales: SaleRecord[];
  /** value per grading company and grade, from real graded sales (method "sales") or estimated (method "multiplier") */
  graded: GradedValue[];
  /** condition ladder NM → DMG */
  conditions: ConditionValue[];
}

export interface GradedValue {
  company: string; grade: number; value: number; low: number | null; high: number | null;
  n: number; n90: number; lastSoldAt: string | null; method: "sales" | "multiplier";
}

export interface CardmarketGuidePoint {
  date: string;
  avg: number | null; low: number | null; trend: number | null;
  avg1: number | null; avg7: number | null; avg30: number | null;
  foilAvg: number | null; foilLow: number | null; foilTrend: number | null;
  foilAvg1: number | null; foilAvg7: number | null; foilAvg30: number | null;
}

export interface PricePoint { date: string; value: number; language?: Language; variant?: Variant; source?: string }

/** A full daily price series for a card (compact tuples), already converted to EUR. */
export interface PriceSeries {
  key: string;                                  // "<source>|<language>|<variant>"
  source: "tcgplayer" | "cardmarket" | "sammlerwert";
  label: string;
  language: Language | "all";
  variant: Variant;
  currency: "EUR";
  points: Array<[date: string, value: number]>;
}

/** Value per condition on the US scale (NM/LP/MP/HP/DMG) with the Cardmarket equivalents; estimated from NM until sales exist. */
export interface ConditionValue {
  code: "NM" | "LP" | "MP" | "HP" | "DMG";
  cardmarket: Condition[];
  label: string;
  multiplier: number;
  value: number | null;
  n: number;                                    // sales in that bucket (180 days)
  method: "sales" | "estimate";
}

export interface SaleRecord {
  id: number;
  cardId: string;
  language: Language;
  variant: Variant;
  condition: Condition | null;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  priceEur: number;
  shippingEur: number | null;
  soldAt: string;
  source: SaleSource;
  title: string | null;
  url: string | null;
  verified: boolean;
}

/** One sale in the market feed (sale + the card it belongs to). */
export interface SaleFeedItem extends SaleRecord { card: CardSummary }

export interface CatalogFacets { rarities: Array<{ value: string; n: number }>; categories: Array<{ value: string; n: number }> }

export interface Collection {
  id: number; name: string; isDefault: boolean; description: string | null; color: string | null; shareToken: string | null; sortOrder: number; createdAt: string;
  itemCount: number; quantity: number;
}

export interface CollectionItem {
  id: number;
  collectionId: number;
  cardId: string;
  language: Language;
  variant: Variant;
  condition: Condition;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  certNo: string | null;
  quantity: number;
  purchasePriceEur: number | null;
  purchasedAt: string | null;
  notes: string | null;
  imagePath: string | null;
  createdAt: string;
  source: string | null;             // manual | scan | import:<source> | psa
  card: CardSummary;
  quote: PriceQuote | null;
  currentValue: number | null; // per unit
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  itemCount: number;
  cardCount: number;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  byLanguage: Array<{ language: Language; value: number; count: number }>;
  bySet: Array<{ setId: string; setName: string; value: number; count: number }>;
  /** raw vs. graded (per company) */
  byKind: Array<{ kind: string; value: number; count: number }>;
  topHoldings: CollectionItem[];
  movers: Array<{ item: CollectionItem; change30: number }>;
  history: PricePoint[];
  insights: Insight[];
}

export interface Insight { kind: "info" | "up" | "down" | "warn"; title: string; text: string; cardId?: string }

export interface User { id: number; email: string; name: string | null; plan: Plan; planStatus: string | null; locale: string; createdAt: string; totpEnabled: boolean }
/** Answer of /api/auth/me, login and register: either a full session or a pending second-factor step. */
export type MfaStep = "setup" | "verify" | null;
export interface AuthResponse { user: User | null; mfa: MfaStep; email?: string }

export interface ApiError { error: string; code?: string }

export interface ScanFactsPublic {
  name: string | null; number: string | null; total: number | null; language: string | null;
  finish: "normal" | "holo" | "reverse" | null; gradingCompany: string | null; grade: number | null; setHint: string | null; cert?: string | null;
}
export interface ScanCandidatePublic { card: CardSummary; score: number; reasons: string[] }
export interface ScanResultPublic { facts: ScanFactsPublic; best: ScanCandidatePublic | null; alternatives: ScanCandidatePublic[]; confidence: number; ms: number }
