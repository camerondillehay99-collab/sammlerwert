// Small robust-statistics toolkit (weighted median, percentiles, MAD trimming).

export interface WPoint { v: number; w: number }

export function weightedQuantile(points: WPoint[], q: number): number | null {
  const pts = points.filter((p) => Number.isFinite(p.v) && p.w > 0).sort((a, b) => a.v - b.v);
  if (!pts.length) return null;
  const total = pts.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of pts) {
    acc += p.w;
    if (acc / total >= q) return p.v;
  }
  return pts[pts.length - 1]!.v;
}

export const weightedMedian = (p: WPoint[]) => weightedQuantile(p, 0.5);

/** Remove outliers farther than k·MAD from the weighted median (MAD scaled to σ). Keeps ≥ 3 points. */
export function trimOutliers(points: WPoint[], k = 3): WPoint[] {
  if (points.length < 4) return points;
  const med = weightedMedian(points);
  if (med == null) return points;
  const dev = points.map((p) => ({ v: Math.abs(p.v - med), w: p.w }));
  const mad = (weightedMedian(dev) ?? 0) * 1.4826;
  if (mad === 0) return points; // identical prices – nothing to trim
  const kept = points.filter((p) => Math.abs(p.v - med) <= k * mad);
  return kept.length >= 3 ? kept : points;
}

export function sumWeights(points: WPoint[]): number { return points.reduce((s, p) => s + p.w, 0); }

export function round2(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

export function daysBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 86_400_000;
}
