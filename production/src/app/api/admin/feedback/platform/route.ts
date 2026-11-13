/**
 * GET /api/admin/feedback/platform — every tenant's feedback, for the platform owner.
 *
 * ─── WHY THIS ROUTE EXISTS AT ALL ───────────────────────────────────────────
 * A tester was given his own tenant (Gamma Co) precisely so he could file bug
 * reports against the app. He filed one on 22 Aug. Nobody could read it: `feedback` carries
 * `feedback_select USING (tenant_id = current_tenant_id())`, so /admin/feedback shows the
 * signed-in workspace and nothing else. Reporting worked, reading did not, and the feature
 * could not do the job it was built for.
 *
 * ─── WHY A ROUTE AND NOT A WIDER RLS POLICY ─────────────────────────────────
 * The obvious fix is a policy letting the distributor read every row. It is the wrong one.
 * A policy is invisible at the call site: every existing query through the browser client
 * would silently start returning other companies' data, including ones written later by
 * someone who never knew the policy changed. Isolation would then be a thing you have to
 * remember rather than a thing the database enforces.
 *
 * So RLS stays exactly as strict as it is, and the one place allowed to cross the boundary
 * is here — server-side, service-role, behind an explicit check, and impossible to reach
 * by accident from a component.
 *
 * ─── GATED ON THE EXISTING FOUNDER ALLOWLIST, NOT ON A NEW RULE ─────────────
 * lib/platform.ts already answers "who is the platform". I started to gate this on
 * `role = 'owner' AND tenant.tier = 'distributor'` and that would have been a SECOND
 * definition of god-mode, weaker than the one already there — a tier is a database column,
 * so anyone who can write to `tenants` could grant it to themselves. The allowlist is
 * deployment configuration and cannot be reached from inside the app. Its own comment says
 * exactly this: "a tenant can never flip a flag to get in".
 *
 * So one definition, re-checked here server-side against the AUTHENTICATED email — the
 * client copy of the flag only decides whether a toggle is drawn.
 *
 * The bar is deliberately higher than the page's. nav.ts opens /admin/feedback to owner and
 * manager, noting that reports quote whatever the reporter typed and that regularly
 * includes a customer's name. Crossing tenants means OTHER companies' customers.
 *
 * ─── R-2726: SEARCH, FILTERS, SORT, PAGING ──────────────────────────────────
 * The list is now filtered, sorted and paged HERE (50 rows a page) instead of sending 500
 * rows to the browser. The gate did not move: the 401/403 below are decided from the
 * session alone, before the query string is looked at and before the service role exists —
 * so the answer to anyone but the platform owner is the same for every parameter, and
 * search or a workspace filter cannot be used to learn anything about another tenant.
 * There is no "scope" parameter; `ws` only NARROWS what the platform owner already reads.
 * Every value goes through lib/feedback/list-filters (fixed lists, validated ids/dates,
 * escaped + quoted free text).
 *   GET ?q=&status=&type=&sev=&reporter=&ws=&page=&from=&to=&card=&real=1&new=1&since=&sort=&p=
 *        → { rows, total, counts, page, pageSize }
 *   GET ?facets=1 → { facets: { reporters, pages, workspaces }, openToSend }
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { canQueue } from "@/lib/feedback/platform-dispatch";
import {
  FACET_COLUMNS,
  FEEDBACK_PAGE_SIZE,
  buildFacets,
  feedbackPageQueries,
  looseFeedbackQuery,
  parseFeedbackFilters,
  parseSince,
  tallyStatuses,
  type FacetSourceRow,
} from "@/lib/feedback/list-filters";
import type { Database } from "@/lib/supabase/database.types";

type FeedbackRow = Database["public"]["Tables"]["feedback"]["Row"];

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The bucket the uploader actually writes to — lib/queries/feedback.ts:40. It is the
 * SHARED "documents" bucket, not a feedback-specific one; I assumed the latter and had to
 * go and look. Guessing here fails quietly: createSignedUrl on a bucket that does not
 * exist returns no URL rather than throwing, so every screenshot would simply render
 * blank — which is the exact half-readable report this route was written to fix.
 */
const SCREENSHOT_BUCKET = "documents";
const SIGNED_URL_TTL = 60 * 10;

export async function GET(req: Request) {
  /* Identity comes from the USER's session, never from a parameter — a tenant id in the
     query string would make this route its own bypass. */
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  /* Checked BEFORE the admin client is created, so the service role is never instantiated
     for a caller who is not allowed to use it — and before the query string is read. */
  if (!isPlatformAdmin(auth.user.email)) {
    /* §24 — say what would make it work, without describing what is behind it. */
    return NextResponse.json(
      {
        error: "Only the platform owner can read other workspaces' feedback.",
        nextStep: "Your own workspace's reports are on this page already.",
      },
      { status: 403 },
    );
  }

  const params = new URL(req.url).searchParams;
  const admin = createAdminClient();

  const { data: me, error: meErr } = await admin
    .from("users")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .single();
  if (meErr || !me) {
    return NextResponse.json({ error: "Could not read your account" }, { status: 500 });
  }

  let list: FeedbackRow[];
  let paging: { total: number; counts: ReturnType<typeof tallyStatuses>; page: number; pageSize: number };
  try {
    if (params.get("facets") === "1") return NextResponse.json(await readFacets(admin));

    const filters = parseFeedbackFilters(params);
    const queries = feedbackPageQueries(
      (cols) => admin.from("feedback").select(cols),
      filters,
      { scope: "all", since: parseSince(params.get("since")) },
    );
    const [pageRes, countRows] = await Promise.all([
      queries.page(),
      fetchAllRows<{ status: string; agent_claimed_at: string | null }>((a, b) => queries.counts(a, b) as never),
    ]);
    if (pageRes.error) throw pageRes.error;
    list = (pageRes.data ?? []) as FeedbackRow[];
    const counts = tallyStatuses(countRows);
    paging = { total: counts[filters.status], counts, page: filters.pageNo, pageSize: FEEDBACK_PAGE_SIZE };
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "unknown error";
    return NextResponse.json({ error: `Could not read feedback: ${message}` }, { status: 500 });
  }
  if (list.length === 0) return NextResponse.json({ rows: [], ...paging });

  /* Two follow-up queries rather than embeds. This codebase has been bitten by PostgREST
     relationship ambiguity (PGRST201) turning a working page into an empty one, and an
     empty page is exactly the failure this route exists to fix. */
  const [{ data: shots }, { data: tenants }] = await Promise.all([
    admin.from("feedback_screenshots").select("*").in("feedback_id", list.map((r) => r.id)),
    admin.from("tenants").select("id, name").in("id", [...new Set(list.map((r) => r.tenant_id))]),
  ]);

  const tenantName = new Map((tenants ?? []).map((t) => [t.id, t.name]));

  /* Signed server-side. The whole point is that the reader has no storage access to
     another tenant's files — handing back a raw path would leave the image broken and the
     report half-readable, which is where this started. */
  const byParent = new Map<string, { id: string; fileName: string; url: string | null }[]>();
  for (const s of shots ?? []) {
    const { data: signed } = await admin.storage
      .from(SCREENSHOT_BUCKET)
      .createSignedUrl(s.file_path, SIGNED_URL_TTL);
    const list_ = byParent.get(s.feedback_id) ?? [];
    /* file_name is nullable in the schema. Coalesced here rather than in the component so
       there is one answer to "what do we call a nameless screenshot" instead of one per
       place that renders it. */
    list_.push({ id: s.id, fileName: s.file_name ?? "screenshot", url: signed?.signedUrl ?? null });
    byParent.set(s.feedback_id, list_);
  }

  return NextResponse.json({
    rows: list.map((r) => ({
      ...r,
      tenantName: tenantName.get(r.tenant_id) ?? "(unknown workspace)",
      /* Marked so the screen can show whose report it is without the reader having to
         compare ids — the whole reason this was invisible was a tenant boundary nobody
         could see. */
      isOwnWorkspace: r.tenant_id === me.tenant_id,
      screenshots: byParent.get(r.id) ?? [],
    })),
    ...paging,
  });
}

/** The picker choices (reporters, pages, workspaces) over every report, and the "Send all open" count. */
async function readFacets(admin: ReturnType<typeof createAdminClient>) {
  type Row = FacetSourceRow & { status: string; dispatched_at: string | null };
  const [rows, { data: tenants }] = await Promise.all([
    fetchAllRows<Row>((a, b) =>
      looseFeedbackQuery(admin.from("feedback").select(FACET_COLUMNS)).order("id", { ascending: true }).range(a, b) as never),
    admin.from("tenants").select("id, name"),
  ]);
  const names = new Map((tenants ?? []).map((t) => [t.id, t.name]));
  return { facets: buildFacets(rows, names), openToSend: rows.filter(canQueue).length };
}
