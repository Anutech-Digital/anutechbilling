/**
 * GET /api/agent/feedback-queue — the reports someone pressed "Run AI Auto-Fix" on, for the
 * AI worker routine to turn into board cards (6 Oct 2026).
 *
 * Until now "Queued for agent" was only a label: the directive went to the clipboard and
 * nothing read the queue, so a report could sit there for days looking as if an agent had it.
 * Pardeep: "haan dusra raasta kar do" — the routine on his machine reads this list every run
 * and makes one card per report; he still decides on the board, and it is still Claude Code
 * that changes the code.
 *
 * Read-only on purpose. It returns only what a card needs (the directive and triage summary,
 * page, severity, and — R-539 — who filed it) — no email, phone, user id or full name, no
 * screenshot — and never changes a row, so a leaked token reads a work list and nothing else.
 * Its own token, not CRON_SECRET: that one can run every cron job; this one cannot run anything.
 *
 * R-539 (Pardeep, 10 Oct 2026): board cards must carry the reporter, so the manager AI can put
 * the card under that person's name at once. This used to say "no reporter name or email";
 * now each item has `reporter` = the lowercased FIRST name only (letters only, e.g.
 * "abhishek"; null when unknown) and `workspace` = the tenant's name (or null). Still no
 * email, and reported_by / tenant_id themselves are never returned.
 *
 * Fails closed: no AGENT_QUEUE_TOKEN configured → 503.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { AGENT_CLAIMED_AT_COLUMN, isMissingColumnError } from "@/lib/feedback/auto-send";
import { URGENT_AT_COLUMN, isUrgent, urgentFirst } from "@/lib/feedback/urgent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIMIT = 50;
/** Read more than LIMIT so claimed rows filtered out below do not shorten the list. */
const FETCH = 200;
const COLS =
  "id, title, problem_summary, directive, reported_type, inferred_type, reported_severity, severity_score, page_path, target_files, dispatched_at, created_at, filed_via, reported_by, tenant_id";

/** R-539: "Abhishek Kumar" → "abhishek". First word, letters only, lowercased; else null. */
function reporterFirstName(fullName: unknown): string | null {
  if (typeof fullName !== "string") return null;
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^\p{L}]/gu, "").toLowerCase() || null;
}

const distinctIds = (rows: Array<Record<string, unknown>>, col: string) =>
  [...new Set(rows.map((r) => r[col]).filter((v): v is string => typeof v === "string" && v.length > 0))];

export async function GET(req: Request) {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) return NextResponse.json({ error: "agent queue not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* Every tenant: a tester's own workspace files reports too (see admin/feedback/platform).
     R-357: a report an AI card already took (agent_claimed_at set) is not handed out again.
     The claim column arrives with migration 20261007110000; until then the first read fails
     on the unknown column and the plain read runs — nothing can be claimed yet anyway. */
  /* R-397: urgent reports first (urgent_at, migration 20261007234000), each with `urgent: true`.
     Before that migration the urgent read fails on the unknown column and the R-357 read runs:
     same list, same order as before. Urgent rows are ordered first in the DB too, so a long
     queue cannot push one past FETCH. */
  const admin = createAdminClient();
  const read = async (cols: string, urgent: boolean) => {
    let q = admin.from("feedback").select(cols).eq("status", "agent_queued");
    if (urgent) q = q.order(URGENT_AT_COLUMN, { ascending: true, nullsFirst: false });
    const { data, error } = await q.order("dispatched_at", { ascending: true }).limit(FETCH);
    return { rows: (data ?? []) as unknown as Array<Record<string, unknown>>, error };
  };
  let res = await read(`${COLS}, ${AGENT_CLAIMED_AT_COLUMN}, ${URGENT_AT_COLUMN}`, true);
  if (res.error && isMissingColumnError(res.error)) res = await read(`${COLS}, ${AGENT_CLAIMED_AT_COLUMN}`, false);
  if (res.error && isMissingColumnError(res.error)) res = await read(COLS, false);
  if (res.error) return NextResponse.json({ error: "could not read the queue" }, { status: 500 });

  const picked = urgentFirst(res.rows.filter((r) => !r[AGENT_CLAIMED_AT_COLUMN])).slice(0, LIMIT);

  /* R-539: who filed it — one users read and one tenants read for the whole list (no N+1).
     A failed lookup only blanks the names; the work list itself still goes out. */
  const userIds = distinctIds(picked, "reported_by");
  const tenantIds = distinctIds(picked, "tenant_id");
  const [users, tenants] = await Promise.all([
    userIds.length ? admin.from("users").select("id, full_name").in("id", userIds) : null,
    tenantIds.length ? admin.from("tenants").select("id, name").in("id", tenantIds) : null,
  ]);
  const firstNameById = new Map<string, string | null>();
  for (const u of (users?.data ?? []) as Array<{ id: string; full_name: unknown }>) {
    firstNameById.set(u.id, reporterFirstName(u.full_name));
  }
  const tenantNameById = new Map<string, string>();
  for (const t of (tenants?.data ?? []) as Array<{ id: string; name: unknown }>) {
    if (typeof t.name === "string" && t.name.trim()) tenantNameById.set(t.id, t.name.trim());
  }

  const items = picked.map((r) => {
    const urgent = isUrgent(r);
    const out: Record<string, unknown> = { ...r };
    delete out[AGENT_CLAIMED_AT_COLUMN];
    delete out[URGENT_AT_COLUMN];
    delete out.reported_by;
    delete out.tenant_id;
    out.reporter = typeof r.reported_by === "string" ? firstNameById.get(r.reported_by) ?? null : null;
    out.workspace = typeof r.tenant_id === "string" ? tenantNameById.get(r.tenant_id) ?? null : null;
    return urgent ? { ...out, urgent: true } : out;
  });

  return NextResponse.json({ env: process.env.NEXT_PUBLIC_APP_ENV || "production", items });
}
