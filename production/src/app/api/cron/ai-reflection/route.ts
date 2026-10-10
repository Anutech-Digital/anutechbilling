/**
 * GET /api/cron/ai-reflection — last night's two questions, answered for a person.
 *
 * Local dev: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/ai-reflection`.
 *
 * ─── WHAT THIS ROUTE DELIBERATELY DOES NOT DO ───────────────────────────────
 * It does not write to any prompt, it does not call a model, and it does not store a summary
 * anywhere the agent reads. The brief asked for the output to be "prompt context mein
 * automatically inject" — see the header of lib/ai/reflection.ts for why that single sentence is
 * the most dangerous request in this system: the reflection reads CUSTOMER MESSAGES and the
 * prompt holds the GUARDS, so wiring one into the other hands every customer a writable channel
 * into the agent's own instructions.
 *
 * So the answer comes back in the response, is logged, and is read by a human. A test asserts
 * that no file on the prompt-building path imports the reflection module at all.
 *
 * ─── AND IT CALLS NO MODEL, WHICH IS ALSO THE POINT ─────────────────────────
 * Both of the brief's questions are answerable by counting: which objection appeared on the most
 * stalled leads, and which seat bands accepted. `detectObjections` is the same function the
 * prompt uses to pick a battlecard, so what gets COUNTED here and what gets ANSWERED there
 * cannot drift. A model in this path would add a paraphrase and a cost and nothing else — and a
 * paraphrase is exactly the artefact that could carry a customer's instruction forward.
 */
import { reportCron } from "@/lib/ops/cron-report";
import { NextResponse } from "next/server";
import { createBareClient } from "@/lib/supabase/bare";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { reflect, type ReflectionInput } from "@/lib/ai/reflection";
import { reflectionEmail, type ReflectionReport } from "@/lib/ai/reflection-digest";
import { sendEmail } from "@/lib/email/send";
import { createAdminClient } from "@/lib/supabase/server";
import "@/lib/sentry";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** How far back the reflection looks. One day, because it runs nightly. */
const WINDOW_HOURS = 24;
/** Rows read per table per tenant — a day's sample. It used to say .limit(2000) and got 1000. */
const MAX_ROWS_PER_TENANT = 2000;

/** Constant-time compare, so a wrong secret cannot be found a character at a time. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: NextRequest) {
  /* ── Auth — FAIL CLOSED ──
     503 rather than 401 when the secret is absent: "this deployment has no cron secret" is a
     missing-infrastructure fact, and reporting it as unauthorized sends whoever is deploying to
     look for a wrong credential instead of an unset one. Matches the fourteen existing crons. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });

  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    /* 503 for the same reason: with no service-role key this would read zero rows and report a
       quiet night, which is an absence dressed as a success. */
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not set — the reflection cannot read its own rows" },
      { status: 503 },
    );
  }

  const db = createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });

  const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  /* Per tenant, because a reflection that mixed two resellers' pipelines would be worse than
     none — and because every table below is tenant-scoped with nothing generated to check it. */
  /* WC-scale: every read here is paged (lib/ops/fetch-all.ts). `.limit(2000)` never returned
     2000 — PostgREST's max_rows cut it to 1000 without a word — and the `.in()` reads sent up
     to 2000 lead ids in one url. */
  const tenantRowsTyped = await fetchAllRows<{ id: string; name: string | null }>((from, to) =>
    db.from("tenants").select("id, name").order("id", { ascending: true }).range(from, to));
  const tenantIds = tenantRowsTyped.map((t) => t.id);
  const nameOf = new Map(tenantRowsTyped.map((t) => [t.id, t.name]));

  const reports: ReflectionReport[] = [];

  for (const tenantId of tenantIds) {
    const [turnRows, actionRows] = await Promise.all([
      fetchAllRows<{ lead_id: string | null; content: string | null }>((from, to) => db
        .from("ai_sales_conversations")
        .select("lead_id, content")
        .eq("tenant_id", tenantId)
        .eq("role", "user")
        .gte("created_at", since)
        .order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(from, to), { maxRows: MAX_ROWS_PER_TENANT }),
      fetchAllRows<{ action: string | null; outcome: string | null; reason: string | null }>((from, to) => db
        .from("ai_action_log")
        .select("action, outcome, reason")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(from, to), { maxRows: MAX_ROWS_PER_TENANT }),
    ]);

    const messages = turnRows
      .flatMap((t) => (t.lead_id && t.content ? [{ leadId: t.lead_id, content: t.content }] : []));

    const leadIds = [...new Set(messages.map((m) => m.leadId))];

    /* Outcome per lead, from the quote table. `accepted` when any quote on it was accepted;
       `stalled` when a quote went out and none was. Anything else is still open — and calling an
       open thread stalled would report a customer who has not replied yet as a loss. */
    const quoteRows = await fetchAllRowsIn<{ lead_id: string | null; status: string | null }, string>(leadIds, (ids, from, to) => db
      .from("quotes")
      .select("lead_id, status")
      .eq("tenant_id", tenantId)
      .in("lead_id", ids)
      .order("id", { ascending: true })
      .range(from, to));

    const leadRows = await fetchAllRowsIn<{ id: string; seats: number | null }, string>(leadIds, (ids, from, to) => db
      .from("leads").select("id, seats").eq("tenant_id", tenantId).in("id", ids)
      .order("id", { ascending: true }).range(from, to));

    const seatsOf = new Map(
      ((leadRows ?? []) as { id: string; seats: number | null }[]).map((l) => [l.id, l.seats]),
    );
    const quotesOf = new Map<string, string[]>();
    for (const q of (quoteRows ?? []) as { lead_id: string | null; status: string | null }[]) {
      if (!q.lead_id) continue;
      quotesOf.set(q.lead_id, [...(quotesOf.get(q.lead_id) ?? []), q.status ?? ""]);
    }

    const input: ReflectionInput = {
      customerMessages: messages,
      leads: leadIds.map((leadId) => {
        const statuses = quotesOf.get(leadId) ?? [];
        const outcome = statuses.includes("accepted")
          ? "accepted"
          : statuses.length > 0
            ? "stalled"
            : "open";
        return { leadId, seats: seatsOf.get(leadId) ?? null, outcome };
      }),
      blocks: actionRows
        .flatMap((a) =>
          a.action && a.outcome ? [{ action: a.action, outcome: a.outcome, reason: a.reason }] : [],
        ),
    };

    const report = reflect(input);

    /* Logged for a person and returned in the response. NOT stored anywhere the agent reads —
       see this file's header and lib/ai/reflection.ts. */
    console.info(
      `[ai-reflection] tenant ${tenantId}: ${report.leadsSeen} leads · ` +
        `${report.stalls.length ? `worst stall ${report.stalls[0].objection} (${report.stalls[0].stalled})` : report.unavailable || "nothing ranked"} · ` +
        `${report.topBlock ? `top block: ${report.topBlock.reason}` : "nothing blocked"}`,
    );

    reports.push({
      tenantId,
      tenantName: nameOf.get(tenantId) ?? null,
      leadsSeen: report.leadsSeen,
      topStall: report.stalls[0]?.objection ?? null,
      stalledCount: report.stalls[0]?.stalled ?? null,
      topBlock: report.topBlock,
      acceptedByBand: report.acceptedByBand.map((a) => ({ band: String(a.band), accepted: a.accepted })),
      withheld: report.unavailable,
    });
  }

  /* ── AND IT HAS TO REACH A PERSON (30 Aug 2026) ──────────────────────────
     Until today this route ended here: `console.info` and a JSON response. Cloud Scheduler
     discards the response, so the reflection went to Cloud Logging and nowhere else. It was
     switched on that morning and the very next question was the right one — where does the
     answer go? It went nowhere anybody looks.

     Not folded into `health-digest`, which returns early on `digest.clean` and sends nothing
     when the app is healthy. Putting a learning note there would deliver it only on the days
     something was ALSO broken.

     `reflectionEmail` returns null when there is nothing to say, and that is the common case
     while the pipeline is young — see its header. Null must stay silent: a note that arrives
     every morning regardless is wallpaper by the end of the week. */
  const mail = reflectionEmail(reports, WINDOW_HOURS);
  if (!mail) {
    return NextResponse.json({
      ok: true, windowHours: WINDOW_HOURS, tenants: reports.length, emailed: false,
      quiet: "nothing worth an email — no ranking, no block, no acceptance", reports,
    });
  }

  /* Same recipient rule as health-digest: the platform owner, oldest first. This is an ops
     note about the app's own behaviour, not a tenant-facing report. */
  const { data: owner } = await createAdminClient()
    .from("users").select("email").eq("role", "owner")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  const to = (owner as { email?: string } | null)?.email ?? null;
  if (!to) {
    return NextResponse.json({
      ok: true, windowHours: WINDOW_HOURS, tenants: reports.length, emailed: false,
      reason: "no owner email on file", reports,
    });
  }

  /* `route` ke bina ye default Resend par jata hai (send.ts:26), aur wo test mode me hai —
     isliye ops mail SPAM me girti thi. Tenant ne Gmail chuna hai to wahi se jaye. */
  const sent = await sendEmail({
    to, subject: mail.subject, text: mail.text,
    route: { tenantId: reports[0].tenantId },
  });
  return NextResponse.json(reportCron("ai-reflection", {
    ok: true, windowHours: WINDOW_HOURS, tenants: reports.length,
    emailed: sent.status === "sent", to, emailError: sent.errorMessage,
    failed: sent.status === "sent" ? 0 : 1, reports,
  }));
}
