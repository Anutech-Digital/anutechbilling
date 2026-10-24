// Not wired yet — R-1608 (built, kept for later)
/**
 * Employee levels, tier multipliers, and the bonus-pool allocation that pays them.
 *
 * ─── WHY THE MULTIPLIER IS SAFE HERE, AND WOULD NOT BE ELSEWHERE ─────────────
 * The brief asks for 1.1× / 1.2× / 1.3× multipliers by tier. Applied to a
 * ₹-per-point RATE that would raise the wage bill by an amount nobody decided in
 * advance. This app pays performance bonus by splitting a POOL the owner types in
 * (`/performance`), so a multiplier changes only the RELATIVE share between
 * people. Total cost stays exactly the pool. That is the difference between a
 * multiplier being a fairness dial and being an unbudgeted liability.
 *
 * It does mean the multiplier is zero-sum: raising a Master's share lowers
 * everyone else's. That is a real consequence and the UI must say it, because
 * "why did my bonus drop when I did the same work?" is the fastest way to lose a
 * team's trust in a bonus system.
 *
 * ─── WHY ALLOCATION USES LARGEST REMAINDER ───────────────────────────────────
 * Rounding each person's share independently does not sum back to the pool. On
 * ₹50,000 across 7 people the drift is a few rupees — small, and exactly the kind
 * of small that makes a payroll run refuse to balance. `allocatePool` distributes
 * whole rupees by largest remainder so the parts always sum to the whole.
 */

/** The four tiers, in order. */
export type TierName = "Apprentice" | "Specialist" | "Expert" | "Master";

export interface Tier {
  name: TierName;
  minLevel: number;
  maxLevel: number;
  /** Weight applied to this person's share of the bonus pool. */
  multiplier: number;
}

export const TIERS: readonly Tier[] = [
  { name: "Apprentice", minLevel: 1,  maxLevel: 10, multiplier: 1.0 },
  { name: "Specialist", minLevel: 11, maxLevel: 25, multiplier: 1.1 },
  { name: "Expert",     minLevel: 26, maxLevel: 40, multiplier: 1.2 },
  { name: "Master",     minLevel: 41, maxLevel: 50, multiplier: 1.3 },
];

export const MAX_LEVEL = 50;

/**
 * XP required to REACH a level.
 *
 * Quadratic, so early levels come quickly (a new joiner sees movement in their
 * first week) and later ones take real work. Level 2 costs 100 XP; level 50
 * costs 120,050 cumulative.
 *
 * Deliberately a closed formula rather than a hand-written table: a 50-row table
 * is 50 chances to fat-finger a number that decides someone's tier.
 */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  if (l <= 1) return 0;
  // 50·(l−1)² + 50·(l−1)  →  L2 = 100, L11 = 5,500, L26 = 32,500, L41 = 82,000
  const n = l - 1;
  return 50 * n * n + 50 * n;
}

/** Level for a given lifetime XP total. Clamped to 1…50. */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  // Invert 50n² + 50n = xp  →  n = (−50 + √(2500 + 200·xp)) / 100
  const n = (-50 + Math.sqrt(2500 + 200 * xp)) / 100;
  return Math.max(1, Math.min(MAX_LEVEL, Math.floor(n) + 1));
}

/** The tier a level belongs to. */
export function tierForLevel(level: number): Tier {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  // The bands cover 1…50 with no gaps, so the last entry is always a valid
  // fallback rather than a silent undefined.
  return TIERS.find((t) => l >= t.minLevel && l <= t.maxLevel) ?? TIERS[TIERS.length - 1];
}

export interface Progress {
  level: number;
  tier: Tier;
  /** XP at the start of the current level. */
  levelFloor: number;
  /** XP needed for the next level, or null at max level. */
  nextLevelAt: number | null;
  /** 0…1 through the current level. 1 at max level. */
  fraction: number;
  /** XP still to go, or null at max level. */
  xpToNext: number | null;
}

/** Everything a progress bar needs, computed once. */
export function progressForXp(xp: number): Progress {
  const safeXp = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
  const level = levelForXp(safeXp);
  const tier = tierForLevel(level);
  const levelFloor = xpForLevel(level);

  if (level >= MAX_LEVEL) {
    return { level, tier, levelFloor, nextLevelAt: null, fraction: 1, xpToNext: null };
  }
  const nextLevelAt = xpForLevel(level + 1);
  const span = nextLevelAt - levelFloor;
  return {
    level, tier, levelFloor, nextLevelAt,
    // span is never 0 below MAX_LEVEL, but guard anyway — a divide-by-zero here
    // would render NaN% on someone's dashboard.
    fraction: span > 0 ? Math.min(1, Math.max(0, (safeXp - levelFloor) / span)) : 1,
    xpToNext: Math.max(0, nextLevelAt - safeXp),
  };
}

// ─── Pool allocation ────────────────────────────────────────────────────────

export interface AllocationInput {
  userId: string;
  /** Performance score for the period (from lib/queries/performance.ts). */
  score: number;
  /** Lifetime XP, which decides the tier multiplier. */
  xp: number;
}

export interface Allocation {
  userId: string;
  score: number;
  level: number;
  tier: TierName;
  multiplier: number;
  /** score × multiplier — the weight actually used to divide the pool. */
  weight: number;
  /** Whole rupees. All allocations sum to exactly the pool. */
  rupees: number;
}

/**
 * Split a bonus pool by score, weighted by tier multiplier.
 *
 * Guarantees, each of which has a test:
 *   • the returned rupees sum to EXACTLY `poolRupees` (largest remainder)
 *   • nobody receives a negative amount
 *   • a zero pool, or zero total weight, pays everyone zero rather than NaN
 *   • order of the input does not change anyone's amount
 */
export function allocatePool(rows: AllocationInput[], poolRupees: number): Allocation[] {
  const pool = Number.isFinite(poolRupees) && poolRupees > 0 ? Math.floor(poolRupees) : 0;

  const weighted = rows.map((r) => {
    const score = Number.isFinite(r.score) && r.score > 0 ? r.score : 0;
    const level = levelForXp(r.xp);
    const tier = tierForLevel(level);
    return {
      userId: r.userId,
      score,
      level,
      tier: tier.name,
      multiplier: tier.multiplier,
      weight: score * tier.multiplier,
    };
  });

  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);

  if (pool === 0 || totalWeight <= 0) {
    return weighted.map((w) => ({ ...w, rupees: 0 }));
  }

  // Floor everyone, then hand the leftover rupees to the largest remainders. Ties
  // break on userId so two runs of the same data always agree — a bonus that
  // moves by ₹1 between refreshes reads as a bug even when the total is right.
  const exact = weighted.map((w) => {
    const raw = (pool * w.weight) / totalWeight;
    const floor = Math.floor(raw);
    return { ...w, floor, remainder: raw - floor };
  });

  let allocated = exact.reduce((s, e) => s + e.floor, 0);
  let leftover = pool - allocated;

  const order = [...exact].sort(
    (a, b) => b.remainder - a.remainder || a.userId.localeCompare(b.userId)
  );
  const bonusRupee = new Set<string>();
  for (const e of order) {
    if (leftover <= 0) break;
    bonusRupee.add(e.userId);
    leftover--;
  }

  return exact.map((e) => ({
    userId: e.userId,
    score: e.score,
    level: e.level,
    tier: e.tier,
    multiplier: e.multiplier,
    weight: e.weight,
    rupees: e.floor + (bonusRupee.has(e.userId) ? 1 : 0),
  }));
}
