/**
 * /api/marketing/social-content/today — R-2690 / R-2691 (G-SOCIAL).
 * GET                       — today's to-do list (made once a day by the AI, else a fixed list).
 * POST { make: "todo" }     — a new list for today.  POST { make: "report" } — this week's report now.
 * PATCH { id, done }        — tick or untick one to-do.
 * Who: the marketing team, owner or manager. 401 · 403 · 400 · 404 · 502.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { canReviewSocial, socialRole } from "@/lib/marketing/social-content";
import { readAutopilotSettings } from "@/lib/marketing/social-autopilot.server";
import { followerRows, makeWeeklyReport, setTodoDone, todayTodo } from "@/lib/marketing/social-report.server";
import { followerTrend } from "@/lib/marketing/social-engagement";
import { istToday } from "@/lib/dates/ist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function team() {
  const session = await getTenantSession();
  if (!session) return { error: NextResponse.json({ error: "Sign in again." }, { status: 401 }) } as const;
  if (!canReviewSocial(await socialRole(session))) return { error: NextResponse.json({ error: "Only the marketing team can use this.", description: "Ask the owner to give you marketing access." }, { status: 403 }) } as const;
  return { session } as const;
}

async function makeTodo(session: NonNullable<Awaited<ReturnType<typeof getTenantSession>>>, fresh: boolean) {
  /* R-2729 / R-2731: one list for every switched-on Page, each task naming its Page. */
  const [pages, ai, rows, counts] = await Promise.all([
    withTenant(session, (tx) => tx.$queryRaw<{ page_id: string; name: string; brief: string }[]>`
      select page_id, name, brief from public.social_pages where tenant_id = ${session.tenantId}::uuid and active order by is_main desc, name`),
    resolveGeminiConfig(createClient(), session.tenantId),
    followerRows(session, 10, null),
    withTenant(session, (tx) => tx.$queryRaw<{ waiting: bigint; today: bigint }[]>`
      select (select count(*) from public.social_comments where tenant_id = ${session.tenantId}::uuid and status = 'draft') as waiting,
             (select count(*) from public.social_content where tenant_id = ${session.tenantId}::uuid and status = 'approved'
                and (scheduled_at at time zone 'Asia/Kolkata')::date = ${istToday()}::date) as today`),
  ]);
  const today = istToday();
  const followers = pages.map((pg) => `${pg.name}: ${(["facebook", "instagram"] as const).map((p) => `${p} ${followerTrend(rows.filter((r) => r.page_id === pg.page_id), p, today).now ?? "unknown"}`).join(", ")}`).join("; ");
  const brief = pages.length > 1
    ? `Pages: ${pages.map((pg) => `"${pg.name}" (${pg.brief || "no brief yet"})`).join("; ")}. Start each task with the Page name in brackets.`
    : pages[0]?.brief ?? "";
  return todayTodo(session, ai, { brief, followers, waitingComments: Number(counts[0]?.waiting ?? 0), postsToday: Number(counts[0]?.today ?? 0) }, { fresh });
}

export async function GET() {
  const r = await team();
  if ("error" in r) return r.error;
  try { return NextResponse.json({ items: await makeTodo(r.session, false) }); }
  catch (e) {
    console.error("[social-todo] load failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not make today's list.", description: "Try again in a minute." }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const r = await team();
  if ("error" in r) return r.error;
  const parsed = z.object({ make: z.enum(["todo", "report"]), pageId: z.string().regex(/^\d{1,30}$/).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose what to make." }, { status: 400 });
  try {
    if (parsed.data.make === "todo") return NextResponse.json({ items: await makeTodo(r.session, true) });
    const [s, ai] = await Promise.all([readAutopilotSettings(r.session, parsed.data.pageId ?? null), resolveGeminiConfig(createClient(), r.session.tenantId)]);
    if (!s.page_id) return NextResponse.json({ error: "Connect a Facebook Page first." }, { status: 409 });
    return NextResponse.json(await makeWeeklyReport(r.session, ai, s.brief, new Date(), s.page_id));
  } catch (e) {
    console.error("[social-today] make failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: parsed.data.make === "todo" ? "Could not make a new list." : "Could not make the report.", description: "Nothing changed. Try again in a minute." }, { status: 502 });
  }
}

export async function PATCH(req: Request) {
  const r = await team();
  if ("error" in r) return r.error;
  const parsed = z.object({ id: z.string().min(1).max(40), done: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a to-do." }, { status: 400 });
  try {
    const names = await withTenant(r.session, (tx) => tx.$queryRaw<{ name: string | null }[]>`
      select coalesce(full_name, email) as name from public.users where id = ${r.session.userId}::uuid limit 1`);
    const items = await setTodoDone(r.session, parsed.data.id, parsed.data.done, names[0]?.name ?? "Someone");
    if (!items) return NextResponse.json({ error: "Today's list is not made yet.", description: "Refresh the page." }, { status: 404 });
    return NextResponse.json({ items });
  } catch (e) {
    console.error("[social-todo] tick failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not save the tick.", description: "Try again." }, { status: 500 });
  }
}
