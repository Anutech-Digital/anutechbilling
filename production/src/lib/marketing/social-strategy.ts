/**
 * R-2705 / R-2706 / R-2707 (G-SOCIAL): the strategy for each platform, the results of each post,
 * and how the weekly learning reads them. Pure — no database, no network (tested in
 * social-strategy.test.ts). Spec: docs/specs/social-organic.md (v3).
 */
import { parseIstLocal } from "./social-schedule";

export const STRATEGY_PLATFORMS = ["facebook", "instagram", "linkedin"] as const;
export type StrategyPlatform = (typeof STRATEGY_PLATFORMS)[number];

export const POST_TYPES = ["tip", "how-to", "question", "checklist", "common mistake", "myth vs fact", "behind the scenes", "story"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const LENGTHS = ["short", "medium", "long"] as const;
export type PostLength = (typeof LENGTHS)[number];

/** What the AI follows when it writes for one platform. */
export interface StrategyPlan {
  /** One line the owner reads first. */
  summary: string;
  audience: string;
  tone: string;
  /** Kinds of post and their share of the week, in % (adds up to 100). */
  mix: { type: PostType; share: number }[];
  length: PostLength;
  hashtags: number;
  /** Hour of the day (India time, 6–22) the post goes out. */
  bestHourIst: number;
  /** What to stay away from (owner's words or what did not work). */
  avoid: string;
}

/** Starting points from what usually works on each platform — used when the AI cannot write one. */
export const DEFAULT_PLANS: Record<StrategyPlatform, StrategyPlan> = {
  facebook: {
    summary: "Helpful tips and questions that start a conversation with small business owners.",
    audience: "Small and medium business owners and office managers",
    tone: "Friendly and helpful, simple words",
    mix: [{ type: "tip", share: 40 }, { type: "question", share: 30 }, { type: "checklist", share: 30 }],
    length: "medium", hashtags: 2, bestHourIst: 10, avoid: "Hard selling, prices, made-up results",
  },
  instagram: {
    summary: "Picture first: short, quick-to-read tips people save for later.",
    audience: "Founders and team leads who scroll on the phone",
    tone: "Short, warm and visual",
    mix: [{ type: "tip", share: 40 }, { type: "myth vs fact", share: 30 }, { type: "behind the scenes", share: 30 }],
    length: "short", hashtags: 8, bestHourIst: 19, avoid: "Links in the text (they do not work on Instagram), long paragraphs",
  },
  linkedin: {
    summary: "Practical lessons from running IT for businesses, written like an expert.",
    audience: "Business owners, IT heads and decision makers",
    tone: "Professional, clear and practical",
    mix: [{ type: "common mistake", share: 35 }, { type: "how-to", share: 35 }, { type: "story", share: 30 }],
    length: "long", hashtags: 3, bestHourIst: 9, avoid: "Emojis in every line, slang, hard selling",
  },
};

const clip = (v: unknown, max: number, fallback: string) => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return (s || fallback).slice(0, max);
};
const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** Accept whatever the AI or a form sent, keep only what is valid, fill the rest from `fallback`. */
export function normalisePlan(raw: unknown, fallback: StrategyPlan): StrategyPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = new Set<PostType>();
  let mix = (Array.isArray(r.mix) ? r.mix : []).flatMap((m) => {
    const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    const type = String(o.type ?? "").toLowerCase().trim() as PostType;
    const share = clamp(o.share, 0, 100, 0);
    if (!POST_TYPES.includes(type) || share <= 0 || seen.has(type)) return [];
    seen.add(type);
    return [{ type, share }];
  }).slice(0, 5);
  if (!mix.length) mix = fallback.mix.map((m) => ({ ...m }));
  // Make the shares add up to exactly 100.
  const total = mix.reduce((a, m) => a + m.share, 0);
  mix = mix.map((m) => ({ ...m, share: Math.round((m.share * 100) / total) }));
  mix[0].share += 100 - mix.reduce((a, m) => a + m.share, 0);
  const length = LENGTHS.includes(r.length as PostLength) ? r.length as PostLength : fallback.length;
  return {
    summary: clip(r.summary, 300, fallback.summary),
    audience: clip(r.audience, 200, fallback.audience),
    tone: clip(r.tone, 200, fallback.tone),
    mix, length,
    hashtags: clamp(r.hashtags, 0, 15, fallback.hashtags),
    bestHourIst: clamp(r.bestHourIst, 6, 22, fallback.bestHourIst),
    avoid: clip(r.avoid, 400, fallback.avoid),
  };
}

/** Which kind of post each of `count` posts is, following the mix (largest share first, spread out). */
export function pickTypes(mix: StrategyPlan["mix"], count: number): PostType[] {
  if (count <= 0 || !mix.length) return [];
  const exact = mix.map((m) => ({ type: m.type, want: (m.share * count) / 100 }));
  const got = exact.map((e) => ({ type: e.type, n: Math.floor(e.want), rest: e.want - Math.floor(e.want) }));
  let left = count - got.reduce((a, g) => a + g.n, 0);
  for (const g of [...got].sort((a, b) => b.rest - a.rest)) { if (left <= 0) break; g.n++; left--; }
  const out: PostType[] = [];
  // Round-robin so the same kind is not posted two days in a row when it can be avoided.
  while (out.length < count) for (const g of got) if (g.n > 0 && out.length < count) { out.push(g.type); g.n--; }
  return out;
}

/** The plan in plain words, for the AI prompt and the screen. */
export function describePlan(platform: StrategyPlatform, plan: StrategyPlan): string {
  const name = platform === "facebook" ? "Facebook" : platform === "instagram" ? "Instagram" : "LinkedIn";
  return [
    `${name} strategy: ${plan.summary}`,
    `Audience: ${plan.audience}. Tone: ${plan.tone}.`,
    `Length: ${plan.length === "short" ? "short (under 300 characters)" : plan.length === "medium" ? "medium (300-800 characters)" : "long (800-1800 characters)"}.`,
    `Hashtags: ${plan.hashtags === 0 ? "none" : `about ${plan.hashtags}`}. Avoid: ${plan.avoid}.`,
  ].join(" ");
}

/** The same IST day as `day`, at `hour`:00 India time. */
export function atIstHour(day: Date, hour: number): Date {
  const ist = new Date(day.getTime() + 330 * 60_000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return parseIstLocal(`${ist.getUTCFullYear()}-${p2(ist.getUTCMonth() + 1)}-${p2(ist.getUTCDate())}T${p2(Math.min(22, Math.max(6, hour)))}:00`)!;
}

// ── R-2706: results of a post ──────────────────────────────────────────────────────────────

/** What Meta tells us about one post. Missing numbers stay null (e.g. reach without permission). */
export interface PostStats {
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

/** One number to compare posts: comments, shares and saves count more than a like. */
export function engagementScore(s: PostStats): number {
  return (s.likes ?? 0) + 2 * (s.comments ?? 0) + 3 * (s.shares ?? 0) + 3 * (s.saves ?? 0);
}

/** Results are read once a post has been out this long (most of its reach comes in the first days). */
export const RESULTS_AFTER_DAYS = 2;

// ── R-2707: what the weekly learning sees ───────────────────────────────────────────────────

export const MIN_RESULTS_TO_LEARN = 3;

export interface PostResult { postType: string | null; hourIst: number; stats: PostStats }

export interface Performance {
  posts: number;
  avgScore: number;
  byType: { type: string; posts: number; avgScore: number; avgReach: number | null }[];
  byHour: { hourIst: number; posts: number; avgScore: number }[];
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export function summarisePerformance(results: readonly PostResult[]): Performance {
  const byType = new Map<string, PostResult[]>();
  const byHour = new Map<number, PostResult[]>();
  for (const r of results) {
    const t = r.postType ?? "other";
    byType.set(t, [...(byType.get(t) ?? []), r]);
    byHour.set(r.hourIst, [...(byHour.get(r.hourIst) ?? []), r]);
  }
  return {
    posts: results.length,
    avgScore: avg(results.map((r) => engagementScore(r.stats))),
    byType: [...byType].map(([type, rs]) => {
      const reaches = rs.map((r) => r.stats.reach).filter((x): x is number => x !== null);
      return { type, posts: rs.length, avgScore: avg(rs.map((r) => engagementScore(r.stats))), avgReach: reaches.length ? avg(reaches) : null };
    }).sort((a, b) => b.avgScore - a.avgScore),
    byHour: [...byHour].map(([hourIst, rs]) => ({ hourIst, posts: rs.length, avgScore: avg(rs.map((r) => engagementScore(r.stats))) })).sort((a, b) => b.avgScore - a.avgScore),
  };
}

/** The table the AI reads before it changes a strategy. */
export function describePerformance(p: Performance): string {
  const types = p.byType.map((t) => `${t.type}: ${t.posts} post${t.posts === 1 ? "" : "s"}, score ${t.avgScore}${t.avgReach !== null ? `, reach ${t.avgReach}` : ""}`).join("; ");
  const hours = p.byHour.map((h) => `${h.hourIst}:00 → score ${h.avgScore} (${h.posts})`).join("; ");
  return `${p.posts} posts with results, average score ${p.avgScore} (likes + 2×comments + 3×shares + 3×saves). By kind: ${types}. By hour (India time): ${hours}.`;
}
