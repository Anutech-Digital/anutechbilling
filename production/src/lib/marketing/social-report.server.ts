/**
 * R-2690 (G-SOCIAL): the weekly report — followers gained per platform, posts that went out, the
 * best post by score, comments answered, and the AI's short advice. Saved per week (Monday, India
 * date) in social_reports; made by the weekly plan and by "Make report now".
 *
 * R-2691: the daily to-do list — 5 things that grow the audience but that Meta / LinkedIn do not let
 * software do (invites, commenting on others' posts, sharing to groups, real photos…).
 */
import "server-only";
import { withTenant, type TenantSession } from "@/server/db";
import { geminiJson } from "@/lib/ai/gemini";
import { istToday, utcDateISO } from "@/lib/dates/ist";
import { engagementScore, type PostStats } from "./social-strategy";
import {
  followerTrend, normaliseTodo, tickTodo, weekStart, type FollowerPlatform, type FollowerRow, type TodoItem,
} from "./social-engagement";
import { logPersonActivity } from "./social-activity";

interface AiConfig { apiKey: string | null; model: string }
const PLATFORMS: FollowerPlatform[] = ["facebook", "instagram", "linkedin"];

export interface WeeklyReport {
  weekStart: string;
  followers: Record<FollowerPlatform, { now: number | null; change7: number | null }>;
  posts: { facebook: number; instagram: number };
  best: { platform: string; caption: string; score: number; stats: PostStats } | null;
  comments: { received: number; answered: number };
}

export async function followerRows(session: TenantSession, days = 60): Promise<FollowerRow[]> {
  const rows = await withTenant(session, (tx) => tx.$queryRaw<{ platform: FollowerPlatform; day: Date; followers: number }[]>`
    select platform, day, followers from public.social_followers
    where tenant_id = ${session.tenantId}::uuid and day > (current_date - ${days}::int) order by day`);
  return rows.map((r) => ({ platform: r.platform, day: utcDateISO(new Date(r.day)) /* a Postgres date is UTC midnight */, followers: Number(r.followers) }));
}

/** The numbers of the last 7 days (no AI). */
export async function reportNumbers(session: TenantSession, now: Date = new Date()): Promise<WeeklyReport> {
  const today = istToday(now);
  const rows = await followerRows(session);
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [posts, comments] = await Promise.all([
    withTenant(session, (tx) => tx.$queryRaw<{ platform: string; caption: string; stats: PostStats | null }[]>`
      select platform, caption, stats from public.social_content
      where tenant_id = ${session.tenantId}::uuid and status = 'published' and published_at >= ${since}::timestamptz`),
    withTenant(session, (tx) => tx.$queryRaw<{ received: bigint; answered: bigint }[]>`
      select count(*) as received, count(*) filter (where status = 'replied') as answered from public.social_comments
      where tenant_id = ${session.tenantId}::uuid and coalesce(commented_at, created_at) >= ${since}::timestamptz`),
  ]);
  const scored = posts.filter((p) => p.stats).map((p) => ({ platform: p.platform, caption: p.caption.slice(0, 160), stats: p.stats!, score: engagementScore(p.stats!) })).sort((a, b) => b.score - a.score);
  return {
    weekStart: weekStart(today),
    followers: Object.fromEntries(PLATFORMS.map((p) => { const t = followerTrend(rows, p, today); return [p, { now: t.now, change7: t.change7 }]; })) as WeeklyReport["followers"],
    posts: { facebook: posts.filter((p) => p.platform === "facebook").length, instagram: posts.filter((p) => p.platform === "instagram").length },
    best: scored[0] ?? null,
    comments: { received: Number(comments[0]?.received ?? 0), answered: Number(comments[0]?.answered ?? 0) },
  };
}

/** Make (or remake) this week's report with the AI's advice and save it. */
export async function makeWeeklyReport(session: TenantSession, ai: AiConfig, brief: string, now: Date = new Date()): Promise<{ report: WeeklyReport; summary: string }> {
  const report = await reportNumbers(session, now);
  let summary = "";
  if (ai.apiKey) {
    const r = await geminiJson<{ summary?: string }>({
      apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId, label: "marketing/social-report", temperature: 0.3,
      system: "You write a short weekly social media report for a non-technical business owner in India. 3-5 plain sentences: what grew, what worked best, and 1-2 concrete things to do next week. Use only the numbers given — never invent any. If there is little data yet, say so kindly and say what to do. Return JSON {\"summary\":\"…\"}.",
      user: `Business: ${brief || "cloud services reseller"}\nThis week: ${JSON.stringify(report)}`,
    });
    summary = (r?.summary ?? "").trim().slice(0, 2000);
  }
  await withTenant(session, (tx) => tx.$executeRaw`
    insert into public.social_reports (tenant_id, week_start, report, summary)
    values (${session.tenantId}::uuid, ${report.weekStart}::date, ${JSON.stringify(report)}::jsonb, ${summary})
    on conflict (tenant_id, week_start) do update set report = excluded.report, summary = excluded.summary, created_at = now()`);
  await logPersonActivity(session, { actor: "ai", action: "Wrote the weekly report", detail: summary.slice(0, 200) || "Numbers only (no AI key)." });
  return { report, summary };
}

export async function latestReport(session: TenantSession): Promise<{ report: WeeklyReport; summary: string; created_at: Date } | null> {
  const rows = await withTenant(session, (tx) => tx.$queryRaw<{ report: WeeklyReport; summary: string; created_at: Date }[]>`
    select report, summary, created_at from public.social_reports where tenant_id = ${session.tenantId}::uuid order by week_start desc limit 1`);
  return rows[0] ?? null;
}

// ── R-2691: today's list ────────────────────────────────────────────────────────────────────

export async function readTodo(session: TenantSession, now: Date = new Date()): Promise<TodoItem[] | null> {
  const rows = await withTenant(session, (tx) => tx.$queryRaw<{ items: TodoItem[] }[]>`
    select items from public.social_todo where tenant_id = ${session.tenantId}::uuid and day = ${istToday(now)}::date`);
  return rows[0]?.items ?? null;
}

/** Today's list — made once a day (AI, else the fallback list). `fresh` makes a new one. */
export async function todayTodo(session: TenantSession, ai: AiConfig, context: { brief: string; followers: string; waitingComments: number; postsToday: number }, opts: { fresh?: boolean; now?: Date } = {}): Promise<TodoItem[]> {
  const now = opts.now ?? new Date();
  const day = istToday(now);
  if (!opts.fresh) { const have = await readTodo(session, now); if (have) return have; }
  let raw: unknown = null;
  if (ai.apiKey) {
    const r = await geminiJson<{ items?: unknown }>({
      apiKey: ai.apiKey, model: ai.model, tenantId: session.tenantId, label: "marketing/social-todo", temperature: 0.6,
      system: "You give a small business's marketing person 5 short tasks for today that grow its Facebook / Instagram / LinkedIn audience and that software is NOT allowed to do (Meta and LinkedIn forbid automation): inviting people who reacted to like the Page, liking and commenting on others' posts, sharing posts to personal profiles and WhatsApp / LinkedIn groups, answering DMs, taking real photos or short videos, asking happy customers for a review. Each task: under 15 words, concrete, doable in 2-3 minutes; plus a one-line why. Honest only. Return JSON {\"items\":[{\"text\",\"why\"}]}.",
      user: `Business: ${context.brief || "cloud services reseller"}. Followers: ${context.followers}. Comments waiting for a reply: ${context.waitingComments}. Posts going out today: ${context.postsToday}.`,
    });
    raw = r?.items ?? null;
  }
  const items = normaliseTodo(raw, day);
  await withTenant(session, (tx) => tx.$executeRaw`
    insert into public.social_todo (tenant_id, day, items) values (${session.tenantId}::uuid, ${day}::date, ${JSON.stringify(items)}::jsonb)
    on conflict (tenant_id, day) do update set items = excluded.items, created_at = now()`);
  return items;
}

export async function setTodoDone(session: TenantSession, id: string, done: boolean, byName: string, now: Date = new Date()): Promise<TodoItem[] | null> {
  const day = istToday(now);
  const items = await withTenant(session, async (tx) => {
    const rows = await tx.$queryRaw<{ items: TodoItem[] }[]>`
      select items from public.social_todo where tenant_id = ${session.tenantId}::uuid and day = ${day}::date for update`;
    if (!rows[0]) return null;
    const next = tickTodo(rows[0].items, id, done, byName, now.toISOString());
    await tx.$executeRaw`update public.social_todo set items = ${JSON.stringify(next)}::jsonb where tenant_id = ${session.tenantId}::uuid and day = ${day}::date`;
    return next;
  });
  const item = items?.find((t) => t.id === id);
  if (item) await logPersonActivity(session, { action: done ? "Did a to-do" : "Un-ticked a to-do", detail: item.text });
  return items;
}
