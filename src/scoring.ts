// Fairness scoring. Pure functions over the per-venue travel-time matrix, so
// switching modes is instant: no graph search is re-run.

export type Mode = 'max' | 'total' | 'gap';

export const MODES: Record<Mode, { label: string; blurb: string }> = {
  max: { label: 'No long hauls', blurb: 'Minimize the longest trip, so nobody gets stuck with a marathon drive.' },
  total: { label: 'Least driving', blurb: 'Minimize the group’s combined driving time.' },
  gap: { label: 'Most equal', blurb: 'Make everyone’s trip as close to equal as possible.' },
};

export const MODE_ORDER: Mode[] = ['max', 'total', 'gap'];

export interface Stats { total: number; max: number; min: number; gap: number }

export function statsOf(times: number[]): Stats {
  let total = 0, max = -Infinity, min = Infinity;
  for (const t of times) { total += t; if (t > max) max = t; if (t < min) min = t; }
  return { total, max, min, gap: max - min };
}

/**
 * Pure "minimize the gap" happily picks a spot where everyone drives 50 minutes,
 * since 50/50/50 is perfectly equal. So the gap mode only considers venues whose
 * longest trip is within this factor of the best achievable longest trip.
 */
const GAP_MODE_MAX_SLACK = 1.4;

/**
 * Returns venue indices ranked best-first under `mode`.
 * Primary key per mode, with a sensible secondary key to break ties:
 *   max   → longest trip, then total
 *   total → total, then longest trip
 *   gap   → (max − min), then longest trip
 */
export function rankVenues(venues: { times: number[] }[], mode: Mode, limit = 4): number[] {
  const stats = venues.map((v) => statsOf(v.times));
  let pool = stats.map((_, i) => i);
  if (mode === 'gap') {
    const bestMax = Math.min(...stats.map((s) => s.max));
    pool = pool.filter((i) => stats[i].max <= bestMax * GAP_MODE_MAX_SLACK);
  }
  const key = (s: Stats): [number, number] =>
    mode === 'max' ? [s.max, s.total] : mode === 'total' ? [s.total, s.max] : [s.gap, s.max];
  pool.sort((a, b) => {
    const ka = key(stats[a]), kb = key(stats[b]);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  // Skip near-duplicates (several venues snapped to the same road node).
  const out: number[] = [];
  const seenNode = new Set<number>();
  for (const i of pool) {
    const node = (venues[i] as { node?: number }).node ?? i;
    if (seenNode.has(node)) continue;
    seenNode.add(node);
    out.push(i);
    if (out.length >= limit) break;
  }
  return out;
}

export const fmtMin = (secs: number) => `${Math.max(1, Math.round(secs / 60))} min`;
