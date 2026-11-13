/**
 * R-2705 / R-2707 (G-SOCIAL): read, start, edit and improve each platform's strategy.
 *
 * - First strategy: the AI writes one per platform from the owner's brief (DEFAULT_PLANS when the
 *   AI cannot). Version 1, active.
 * - Owner/manager edit: a new active version; the old one is kept as 'replaced'.
 * - Weekly learning (learnStrategies): with MIN_RESULTS_TO_LEARN+ posts with results on a platform,
 *   the AI keeps what worked and changes what did not. Autopilot → the new version is active at
 *   once; Ask me first → it waits as 'proposed' for Use it / Keep old. Stop all AI is checked by
 *   the caller (planWeek returns before this when paused).
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { geminiJson } from "@/lib/ai/gemini";
import { logPersonActivity } from "./social-activity";
import {
  DEFAULT_PLANS, MIN_RESULTS_TO_LEARN, POST_TYPES, STRATEGY_PLATFORMS, describePerformance, describePlan, normalisePlan,
  summarisePerformance, type PostStats, type StrategyPlan, type StrategyPlatform,
} from "./social-strategy";

export interface StrategyRow { platform: StrategyPlatform; version: number; plan: StrategyPlan; reason: string; status: "active" | "proposed"; created_by: string | null; created_at: Date }
export type Strategies = Record<StrategyPlatform, { active: StrategyRow | null; proposed: StrategyRow | null }>;

interface AiConfig { apiKey: string | null; model: string }

const name = (p: StrategyPlatform) => (p === "facebook" ? "Facebook" : p === "instagram" ? "Instagram" : "LinkedIn");
const PLAN_SHAPE = `{"summary":"one line","audience":"…","tone":"…","mix":[{"type":"one of: ${POST_TYPES.join(" | ")}","share":40}],"length":"short|medium|long","hashtags":3,"bestHourIst":10,"avoid":"…"}`;

/** R-2729: strategies belong to one Page (its Facebook, Instagram and LinkedIn plans). */
export async function readStrategies(session: TenantSession, pageId: string): Promise<Strategies> {
  const rows = await withTenant(session, (tx) => tx.$queryRaw<StrategyRow[]>`
    select platform, version, plan, reason, status, created_by, created_at from public.social_strategy
    where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and status in ('active', 'proposed')`);
  const out = Object.fromEntries(STRATEGY_PLATFORMS.map((p) => [p, { active: null, proposed: null }])) as Strategies;
  for (const r of rows) {
    const fixed = { ...r, plan: normalisePlan(r.plan, DEFAULT_PLANS[r.platform]) };
    if (r.status === "active") out[r.platform].active = fixed; else out[r.platform].proposed = fixed;
  }
  return out;
}

/** The plan to follow now for a platform (its active version, else the default). */
export function planFor(s: Strategies, p: StrategyPlatform): { plan: StrategyPlan; version: number | null } {
  return s[p].active ? { plan: s[p].active!.plan, version: s[p].active!.version } : { plan: DEFAULT_PLANS[p], version: null };
}

/** Save a new version. 'active' replaces the active one; 'proposed' replaces a waiting proposal. */
async function saveVersion(session: TenantSession, pageId: string, platform: StrategyPlatform, plan: StrategyPlan, reason: string, status: "active" | "proposed", byPerson: boolean): Promise<number> {
  return withTenant(session, async (tx) => {
    const next = await tx.$queryRaw<{ v: number }[]>`
      select coalesce(max(version), 0) + 1 as v from public.social_strategy where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and platform = ${platform}`;
    const version = Number(next[0].v);
    if (status === "active") {
      await tx.$executeRaw`update public.social_strategy set status = 'replaced' where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and platform = ${platform} and status = 'active'`;
      await tx.$executeRaw`update public.social_strategy set status = 'rejected' where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and platform = ${platform} and status = 'proposed'`;
    } else {
      await tx.$executeRaw`update public.social_strategy set status = 'rejected' where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and platform = ${platform} and status = 'proposed'`;
    }
    await tx.$executeRaw`
      insert into public.social_strategy (tenant_id, page_id, platform, version, plan, reason, status, created_by)
      values (${session.tenantId}::uuid, ${pageId}, ${platform}, ${version}, ${JSON.stringify(plan)}::jsonb, ${reason.slice(0, 1500)}, ${status}, ${byPerson ? session.userId : null}::uuid)`;
    return version;
  });
}

/** R-2705: the first strategy for every platform that has none (one AI call). */
export async function ensureStrategies(session: TenantSession, pageId: string, ai: AiConfig, brief: string, current?: Strategies): Promise<Strategies> {
  const s = current ?? await readStrategies(session, pageId);
  const missing = STRATEGY_PLATFORMS.filter((p) => !s[p].active);
  if (!missing.length) return s;
  let fromAi: Record<string, unknown> = {};
  if (ai.apiKey) {
    const result = await geminiJson<Record<string, unknown>>({
      apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId, label: "marketing/social-strategy", temperature: 0.4,
      system: `You are a social media strategist for a B2B cloud services reseller in India that wants more followers. For each platform asked, return a strategy in this JSON shape: ${PLAN_SHAPE}. Use what usually works on that platform (Facebook: conversation and community; Instagram: picture first, short, saves; LinkedIn: expert, practical, professional). Each post is text plus ONE picture (no carousels, videos or reels yet). Honest only: no invented results, prices or testimonials. Return {"facebook":{…},"instagram":{…},"linkedin":{…}} with only the platforms asked.`,
      user: `Platforms: ${missing.join(", ")}. Business: ${brief || "a cloud services reseller (Google Workspace, Microsoft 365, Zoho) for small businesses"}.`,
    });
    fromAi = result ?? {};
  }
  for (const p of missing) {
    const used = Boolean(fromAi[p]);
    const plan = normalisePlan(fromAi[p], DEFAULT_PLANS[p]);
    await saveVersion(session, pageId, p, plan, used ? `First strategy, written by the AI from your business brief and what usually works on ${name(p)}.` : `First strategy: what usually works on ${name(p)}. The AI will improve it from your results.`, "active", false);
    await logPersonActivity(session, { pageId, actor: "ai", platform: p, action: "Wrote a strategy", detail: plan.summary });
  }
  return readStrategies(session, pageId);
}

/** R-2705: owner / manager edits a strategy → a new active version. */
export async function editStrategy(session: TenantSession, pageId: string, platform: StrategyPlatform, raw: unknown): Promise<StrategyRow> {
  const s = await readStrategies(session, pageId);
  const plan = normalisePlan(raw, planFor(s, platform).plan);
  await saveVersion(session, pageId, platform, plan, "Changed by a person.", "active", true);
  await logPersonActivity(session, { pageId, platform, action: "Changed the strategy", detail: plan.summary });
  return (await readStrategies(session, pageId))[platform].active!;
}

/** R-2707: Use it / Keep old on a proposed change. */
export async function decideProposal(session: TenantSession, pageId: string, platform: StrategyPlatform, accept: boolean): Promise<boolean> {
  const done = await withTenant(session, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      select id from public.social_strategy where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and platform = ${platform} and status = 'proposed' limit 1 for update`;
    if (!rows[0]) return false;
    if (accept) await tx.$executeRaw`update public.social_strategy set status = 'replaced' where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and platform = ${platform} and status = 'active'`;
    await tx.$executeRaw`update public.social_strategy set status = ${accept ? "active" : "rejected"} where id = ${rows[0].id}::uuid`;
    return true;
  });
  if (done) await logPersonActivity(session, { pageId, platform, action: accept ? "Used the AI's new strategy" : "Kept the old strategy" });
  return done;
}

/**
 * R-2707: the weekly learning. For each platform with enough results, the AI writes the next
 * version from the current plan + what each kind of post and hour scored.
 */
export async function learnStrategies(session: TenantSession, ai: AiConfig, opts: { autopilot: boolean; now?: Date; pageId: string }): Promise<{ platform: StrategyPlatform; outcome: "changed" | "proposed" | "kept" | "need-more"; have: number }[]> {
  const now = opts.now ?? new Date();
  const pageId = opts.pageId;
  const s = await readStrategies(session, pageId);
  const rows = await withTenant(session, (tx) => tx.$queryRaw<{ platform: StrategyPlatform; post_type: string | null; published_at: Date; stats: PostStats }[]>`
    select platform, post_type, published_at, stats from public.social_content
    where tenant_id = ${session.tenantId}::uuid and page_id = ${pageId} and status = 'published' and stats is not null
      and published_at > ${new Date(now.getTime() - 42 * 86_400_000)}::timestamptz`);
  const out: { platform: StrategyPlatform; outcome: "changed" | "proposed" | "kept" | "need-more"; have: number }[] = [];
  for (const platform of STRATEGY_PLATFORMS) {
    const mine = rows.filter((r) => r.platform === platform);
    const current = s[platform].active;
    if (!current) continue;
    if (mine.length < MIN_RESULTS_TO_LEARN) {
      if (platform !== "linkedin") out.push({ platform, outcome: "need-more", have: mine.length });
      continue;
    }
    const perf = summarisePerformance(mine.map((r) => ({
      postType: r.post_type, hourIst: new Date(new Date(r.published_at).getTime() + 330 * 60_000).getUTCHours(), stats: r.stats,
    })));
    if (!ai.apiKey) { out.push({ platform, outcome: "kept", have: mine.length }); continue; }
    const result = await geminiJson<{ plan?: unknown; reason?: string; changed?: boolean }>({
      apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId, label: "marketing/social-strategy-learn", temperature: 0.3,
      system: `You improve a ${name(platform)} strategy from real results. Keep what worked, change what did not: give more share to kinds of post with higher scores, less to low ones, move the hour toward the best hour, and keep the owner's 'avoid' rules. Each post is text plus ONE picture (no carousels or videos). Change little when there are few posts. Return JSON {"changed":true|false,"plan":${PLAN_SHAPE},"reason":"2-3 plain sentences for a non-technical owner: what worked, what you changed and why"}.`,
      user: `Current strategy (version ${current.version}): ${JSON.stringify(current.plan)}\nResults of the last 6 weeks: ${describePerformance(perf)}`,
    });
    const plan = normalisePlan(result?.plan, current.plan);
    const same = JSON.stringify(plan) === JSON.stringify(current.plan);
    if (!result || result.changed === false || same) {
      out.push({ platform, outcome: "kept", have: mine.length });
      await logPersonActivity(session, { pageId, actor: "ai", platform, action: "Kept the strategy", detail: (result?.reason ?? "What is working stays the same this week.").slice(0, 300) });
      continue;
    }
    const reason = (result.reason ?? "Changed from this week's results.").trim();
    await saveVersion(session, pageId, platform, plan, reason, opts.autopilot ? "active" : "proposed", false);
    await logPersonActivity(session, { pageId, actor: "ai", platform, action: opts.autopilot ? "Improved the strategy" : "Suggested a better strategy", detail: reason.slice(0, 300), result: opts.autopilot ? "ok" : "waiting" });
    out.push({ platform, outcome: opts.autopilot ? "changed" : "proposed", have: mine.length });
  }
  return out;
}

export { describePlan };
