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
  sales: SaleRecord[];
  /** value per grading company and grade, from real graded sales (method "sales") or estimated (method "multiplier") */
  graded: GradedValue[];
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
  topHoldings: CollectionItem[];
  movers: Array<{ item: CollectionItem; change30: number }>;
  history: PricePoint[];
  insights: Insight[];
}

export interface Insight { kind: "info" | "up" | "down" | "warn"; title: string; text: string; cardId?: string }

export interface User { id: number; email: string; name: string | null; plan: Plan; planStatus: string | null; locale: string; createdAt: string }

export interface ApiError { error: string; code?: string }

export interface ScanFactsPublic {
  name: string | null; number: string | null; total: number | null; language: string | null;
  finish: "normal" | "holo" | "reverse" | null; gradingCompany: string | null; grade: number | null; setHint: string | null;
}
export interface ScanCandidatePublic { card: CardSummary; score: number; reasons: string[] }
export interface ScanResultPublic { facts: ScanFactsPublic; best: ScanCandidatePublic | null; alternatives: ScanCandidatePublic[]; confidence: number; ms: number }
