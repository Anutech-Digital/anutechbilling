/**
 * /api/cron/task-digest — R-2929: every working morning, each person's overdue + today's tasks.
 *
 * Runs daily at 09:30 IST via Cloud Scheduler (scripts/setup-cloud-scheduler.sh). Until this
 * route nothing reached anybody when a task fell due or went overdue.
 *
 * WHO GETS WHAT (decided in lib/tasks/daily-digest.ts, not here):
 *   · every active team member with at least one open task that is overdue or due today (IST)
 *     gets ONE short list;
 *   · a person with nothing overdue or due today gets nothing;
 *   · the owner gets ONE team summary (who has how many), with their own tasks inside it —
 *     and nothing at all on a day when the whole company has none.
 * "Team member" = tenant_memberships (R-2471): one login can belong to several companies, and
 * users.tenant_id is only the company it has selected right now. A member whose access ended
 * (is_active false, access_ends_on passed, membership ended) is not messaged; the owner still
 * sees their open tasks, marked "(inactive)".
 *
 * NOT ON A DAY OFF: Sunday, the fixed national holidays and the company's own holidays
 * (public.holidays) — the same rule attendance-reminders uses (lib/attendance/working-day.ts).
 *
 * CHANNELS: email always (the company's own mail route). A WhatsApp copy goes too only when
 * the company has an APPROVED WhatsApp template named `task_daily_digest` AND the person's
 * mobile number is OTP-verified (users.phone_verified_at) and has not said STOP — the same
 * template + opt-out tables the S28 reminders use. No such template → email only, and the
 * result says so (`whatsapp_note`). Known limit: like every WhatsApp this app sends, the copy
 * is stored in whatsapp_messages, so it shows in the company's WhatsApp Inbox.
 *
 * ONCE A DAY, GUARANTEED BY THE DATABASE: the slot is claimed in task_digest_log BEFORE
 * anything is sent — unique (tenant_id, user_id, digest_date, kind). A Scheduler retry, "Run
 * now" on /automation after the morning run, or two overlapping instances all hit the unique
 * index and send nothing. When NOTHING went out (email failed and no WhatsApp) the claim is
 * released, so "Retry" after fixing the mail route sends it; a row whose run died between the
 * claim and the send stays (one missed digest, never two).
 *
 * This is mail to the company's own people, so it is NOT behind "Customer messages"
 * (sendInternalEmail / sendInternalWhatsApp) — its own switch on /automation governs it, and
 * like every job it starts OFF.
 *
 * Auth: CRON_SECRET, fail closed. `?dry=1[&on=YYYY-MM-DD]` reports who WOULD get what and
 * sends / writes nothing.
 */
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn, errorMessage, type PageQuery } from "@/lib/ops/fetch-all";
import { mapLimit } from "@/lib/ops/p-limit";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { addDaysISO, istDayStartUtc, istToday } from "@/lib/dates/ist";
import { appUrl } from "@/lib/app-url";
import { isDeactivated } from "@/lib/auth/deactivated";
import { isWorkingDay, SIX_DAY_WEEK_SUNDAY_OFF } from "@/lib/attendance/working-day";
import { isEmailConfigured, sendInternalEmail, sendInternalWhatsApp } from "@/lib/messaging";
import { WhatsAppNotConfiguredError } from "@/lib/whatsapp/send-failure";
import { normalizeWaPhone } from "@/lib/marketing/whatsapp-broadcast";
import { reminderComponents } from "@/lib/marketing/whatsapp-reminders";
import { reportCron } from "@/lib/ops/cron-report";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";
import { gatedCron, cronTenantAllowed, currentCronRun, noteWouldSend } from "@/lib/automation/cron-gate";
import {
  DIGEST_WA_TEMPLATE, DIGEST_WA_TEMPLATE_BODY, closedStatusFilter, digestWhatsAppValues, planTaskDigests,
  renderOwnerSummary, renderPersonalDigest,
  type DigestKind, type DigestPerson, type DigestTask, type OwnerSummary, type PersonalDigest,
} from "@/lib/tasks/daily-digest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Companies worked on at once. Inside a company people are messaged one after another. */
const TENANTS_AT_ONCE = 4;

/* task_digest_log, tenant_memberships and users.phone* are newer than database.types.ts — one
   untyped handle, kept in this file. Untyped means nothing checks the tenant: every read and
   write below names tenant_id. */
type Untyped = Pick<SupabaseClient, "from">;
type Page<T> = PageQuery<T>;

interface TaskRow extends DigestTask { tenant_id: string }
interface MemberRow {
  user_id: string; tenant_id: string; role: string;
  is_active: boolean | null; access_ends_on: string | null; ended_at: string | null;
}
interface UserRow { id: string; email: string | null; full_name: string | null; phone: string | null; phone_verified_at: string | null }

type WhatsAppOutcome = "sent" | "failed" | "no_template" | "no_phone" | "opted_out" | "not_configured";

interface Detail {
  tenant: string; user: string; kind: DigestKind; to: string;
  overdue: number; today: number; email: string; whatsapp: string;
}

interface RunResult {
  ran_at: string;
  evaluated_for: string;
  dry_run: boolean;
  email_mode: "real" | "stub";
  tenants: number;
  /** Companies left out because the day is their day off (Sunday / holiday). */
  day_off: number;
  /** People who had a message due this run (already-sent ones included). */
  considered: number;
  sent: number;
  failed: number;
  skipped_already_sent: number;
  /** People with tasks who get nothing: access ended, or no email on their login. */
  not_reachable: number;
  whatsapp: Record<WhatsAppOutcome, number>;
  /** Plain words for the owner when the WhatsApp copy could not go. */
  whatsapp_note: string | null;
  errors: { tenant: string; message: string }[];
  details: Detail[];
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("task-digest", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }

function realDate(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && addDaysISO(addDaysISO(iso, 1), -1) === iso;
}

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const on = url.searchParams.get("on");
  if (on && !dry) {
    return NextResponse.json({ error: "`on` is only allowed with dry=1 — a live run must use today's date" }, { status: 400 });
  }
  if (on && !realDate(on)) {
    return NextResponse.json({ error: "`on` must be a real date, YYYY-MM-DD" }, { status: 400 });
  }
  const today = on ?? istToday();
  /* First instant of the NEXT IST day: everything due before it is overdue or due today. */
  const dayEnd = istDayStartUtc(addDaysISO(today, 1)).toISOString();

  let tasksUrl: string;
  try {
    tasksUrl = `${appUrl()}/tasks`;
  } catch (e) {
    const message = `app address not configured: ${errorMessage(e)}`;
    return NextResponse.json(reportCron("task-digest", { error: message, errors: [message] }), { status: 500 });
  }

  const db = createAdminClient() as unknown as Untyped;
  const result: RunResult = {
    ran_at: new Date().toISOString(),
    evaluated_for: today,
    dry_run: dry,
    email_mode: isEmailConfigured() ? "real" : "stub",
    tenants: 0, day_off: 0, considered: 0, sent: 0, failed: 0, skipped_already_sent: 0, not_reachable: 0,
    whatsapp: { sent: 0, failed: 0, no_template: 0, no_phone: 0, opted_out: 0, not_configured: 0 },
    whatsapp_note: null,
    errors: [], details: [],
  };

  /* Every open task due before tomorrow, paged (lib/ops/fetch-all.ts) — only for the companies
     this pass may work on when the gate names them. "Open" = not closed — see
     lib/tasks/daily-digest.ts for why it is not TASK_OPEN_STATUSES itself. */
  const run = currentCronRun();
  const onlyTenants = run && !run.allTenants ? [...run.tenants] : null;
  const taskPage = (ids: string[] | null) => (from: number, to: number) => {
    let q = db.from("tasks")
      .select("id, tenant_id, owner_id, title, due_at")
      .not("status", "in", closedStatusFilter())
      .lt("due_at", dayEnd);
    if (ids) q = q.in("tenant_id", ids);
    return q.order("due_at", { ascending: true }).order("id", { ascending: true }).range(from, to) as unknown as Page<TaskRow>;
  };
  let tasks: TaskRow[];
  try {
    tasks = onlyTenants
      ? await fetchAllRowsIn<TaskRow, string>(onlyTenants, (ids, from, to) => taskPage(ids)(from, to))
      : await fetchAllRows<TaskRow>(taskPage(null));
  } catch (e) {
    return cronDbFailure("task-digest", e, `could not read tasks: ${errorMessage(e)}`);
  }

  const tasksByTenant = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    /* R-897 */ if (!cronTenantAllowed(t.tenant_id)) continue;
    const list = tasksByTenant.get(t.tenant_id) ?? [];
    list.push(t);
    tasksByTenant.set(t.tenant_id, list);
  }
  let tenantIds = [...tasksByTenant.keys()];
  if (tenantIds.length === 0) return NextResponse.json(reportCron("task-digest", result));

  /* Day off? Per company: its own holidays on top of Sunday + the national holidays. A failed
     holidays read is loud — read as "no holidays", it would message people on Diwali. */
  try {
    const holidays = await fetchAllRowsIn<{ tenant_id: string }, string>(tenantIds, (ids, from, to) => db
      .from("holidays").select("tenant_id, holiday_date")
      .in("tenant_id", ids).eq("holiday_date", today)
      .order("id", { ascending: true }).range(from, to) as unknown as Page<{ tenant_id: string }>);
    const onHoliday = new Set(holidays.map((h) => h.tenant_id));
    const working = tenantIds.filter((id) => isWorkingDay({
      date: today, weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF, holidayDates: onHoliday.has(id) ? [today] : [],
    }).working);
    result.day_off = tenantIds.length - working.length;
    tenantIds = working;
  } catch (e) {
    return cronDbFailure("task-digest", e, `could not read holidays: ${errorMessage(e)}`);
  }
  result.tenants = tenantIds.length;
  if (tenantIds.length === 0) return NextResponse.json(reportCron("task-digest", result));

  /* The team of each company: memberships (role + access are per company), then the logins. */
  const peopleByTenant = new Map<string, DigestPerson[]>();
  try {
    const members = await fetchAllRowsIn<MemberRow, string>(tenantIds, (ids, from, to) => db
      .from("tenant_memberships")
      .select("user_id, tenant_id, role, is_active, access_ends_on, ended_at")
      .in("tenant_id", ids)
      .order("id", { ascending: true }).range(from, to) as unknown as Page<MemberRow>);
    const logins = await fetchAllRowsIn<UserRow, string>(members.map((m) => m.user_id), (ids, from, to) => db
      .from("users")
      .select("id, email, full_name, phone, phone_verified_at")
      .in("id", ids)
      .order("id", { ascending: true }).range(from, to) as unknown as Page<UserRow>);
    const loginById = new Map(logins.map((u) => [u.id, u]));
    const noon = new Date(`${today}T12:00:00+05:30`);
    for (const m of members) {
      const u = loginById.get(m.user_id);
      if (!u) continue;
      const list = peopleByTenant.get(m.tenant_id) ?? [];
      list.push({
        id: u.id, name: u.full_name, email: u.email, role: m.role,
        /* Only an OTP-verified number: a mistyped one would hand a stranger the task list. */
        phone: u.phone_verified_at ? u.phone : null,
        isActive: !m.ended_at && !isDeactivated(m, noon),
      });
      peopleByTenant.set(m.tenant_id, list);
    }
  } catch (e) {
    return cronDbFailure("task-digest", e, `could not read the team: ${errorMessage(e)}`);
  }

  /* Who already has today's digest, per company. The unique index is the guarantee; this read
     lets a second run (and a practice run) say "already sent" without trying. FAIL CLOSED on a
     live run: if the log cannot be read the claim below could not be trusted either. */
  const already = new Set<string>();
  const slot = (tenantId: string, userId: string, kind: string) => `${tenantId}:${userId}:${kind}`;
  try {
    const rows = await fetchAllRowsIn<{ tenant_id: string; user_id: string; kind: string }, string>(tenantIds, (ids, from, to) => db
      .from("task_digest_log")
      .select("tenant_id, user_id, kind")
      .in("tenant_id", ids).eq("digest_date", today)
      .order("id", { ascending: true }).range(from, to) as unknown as Page<{ tenant_id: string; user_id: string; kind: string }>);
    for (const r of rows) already.add(slot(r.tenant_id, r.user_id, r.kind));
  } catch (e) {
    if (!dry) return cronDbFailure("task-digest", e, `task digest log unreadable — nothing sent: ${errorMessage(e)}`);
    result.errors.push({ tenant: "*", message: `task digest log unreadable (${errorMessage(e)}) — a live run would send nothing` });
  }

  /* WhatsApp: which companies have the approved template, and which numbers said STOP — one
     read each for the whole run. Either unreadable → email only (never "nobody opted out"). */
  const waLanguage = new Map<string, string>();
  const stopped = new Set<string>();
  try {
    const templates = await fetchAllRowsIn<{ tenant_id: string; language: string }, string>(tenantIds, (ids, from, to) => db
      .from("whatsapp_templates")
      .select("tenant_id, language")
      .in("tenant_id", ids).eq("name", DIGEST_WA_TEMPLATE).eq("status", "approved")
      .order("id", { ascending: true }).range(from, to) as unknown as Page<{ tenant_id: string; language: string }>);
    const optOuts = await fetchAllRowsIn<{ tenant_id: string; phone: string }, string>(templates.map((t) => t.tenant_id), (ids, from, to) => db
      .from("whatsapp_opt_outs")
      .select("tenant_id, phone")
      .in("tenant_id", ids)
      .order("phone", { ascending: true }).range(from, to) as unknown as Page<{ tenant_id: string; phone: string }>);
    for (const o of optOuts) stopped.add(`${o.tenant_id}:${o.phone}`);
    for (const t of templates) if (!waLanguage.has(t.tenant_id)) waLanguage.set(t.tenant_id, t.language);
  } catch (e) {
    waLanguage.clear();
    result.errors.push({ tenant: "*", message: `WhatsApp setup unreadable (${errorMessage(e)}) — email only` });
  }
  const tenantsWithoutTemplate = new Set<string>();

  async function sendOne(tenantId: string, d: PersonalDigest | OwnerSummary): Promise<void> {
    result.considered += 1;
    const to = d.person.email!.trim().toLowerCase();
    const base = { tenant: tenantId, user: d.person.id, kind: d.kind, to, overdue: d.overdue.length, today: d.today.length };
    if (already.has(slot(tenantId, d.person.id, d.kind))) { result.skipped_already_sent += 1; return; }

    /* WhatsApp: decided before the claim so a practice run reports the same thing. */
    const language = waLanguage.get(tenantId);
    const phone = language ? normalizeWaPhone(d.person.phone) : null;
    let wa: WhatsAppOutcome | "would_send" =
      !language ? "no_template" : !phone ? "no_phone" : stopped.has(`${tenantId}:${phone}`) ? "opted_out" : "would_send";
    if (!language) tenantsWithoutTemplate.add(tenantId);

    if (dry) {
      /* Shown under "Last run" on /automation: "would send N messages to …". */
      noteWouldSend({ tenantId, to, channel: "email", kind: `task_digest_${d.kind}` });
      if (wa === "would_send") noteWouldSend({ tenantId, to: phone!, channel: "whatsapp", kind: `task_digest_${d.kind}` });
      result.details.push({ ...base, email: "(dry run)", whatsapp: wa === "would_send" ? "(dry run)" : wa });
      return;
    }

    /* Claim the day's slot BEFORE sending. 23505 = another run already has it. */
    const { error: claimErr } = await db.from("task_digest_log").insert({
      tenant_id: tenantId, user_id: d.person.id, digest_date: today, kind: d.kind,
      overdue_count: d.overdue.length, today_count: d.today.length,
    });
    if (claimErr) {
      if ((claimErr as { code?: string }).code === "23505") { result.skipped_already_sent += 1; return; }
      result.errors.push({ tenant: tenantId, message: `could not claim the digest slot: ${claimErr.message}` });
      return;
    }

    const msg = d.kind === "owner_summary"
      ? renderOwnerSummary({ name: d.person.name, today, tasksUrl, totals: d.totals, team: d.team, overdue: d.overdue, dueToday: d.today })
      : renderPersonalDigest({ name: d.person.name, today, tasksUrl, overdue: d.overdue, dueToday: d.today });

    let emailStatus: "sent" | "stubbed" | "failed";
    let error: string | null = null;
    try {
      /* `route`: the company's own mail transport, as compliance-reminders does. */
      const r = await sendInternalEmail({ to, subject: msg.subject, text: msg.text, route: { tenantId } });
      emailStatus = r.status;
      if (r.status === "failed") error = r.errorMessage ?? "email failed";
    } catch (e) {
      emailStatus = "failed";
      error = errorMessage(e);
    }

    if (wa === "would_send") {
      try {
        const values = d.kind === "owner_summary"
          ? digestWhatsAppValues({ name: d.person.name, overdue: d.overdue, dueToday: d.today, team: d.team, totals: d.totals })
          : digestWhatsAppValues({ name: d.person.name, overdue: d.overdue, dueToday: d.today });
        const r = await sendInternalWhatsApp({
          tenantId, to: phone!,
          message: { kind: "template", name: DIGEST_WA_TEMPLATE, language: language!, components: reminderComponents(values) },
        });
        wa = r.status === "failed" ? "failed" : "sent";
      } catch (e) {
        wa = e instanceof WhatsAppNotConfiguredError ? "not_configured" : "failed";
        if (wa === "failed") error = [error, `whatsapp: ${errorMessage(e)}`].filter(Boolean).join("; ");
      }
    }
    const waOutcome = wa as WhatsAppOutcome;
    result.whatsapp[waOutcome] += 1;
    const nothingWentOut = emailStatus === "failed" && waOutcome !== "sent";

    const log = db.from("task_digest_log");
    const { error: logErr } = await (nothingWentOut
      /* Release the claim: a Retry after the mail route is fixed must be able to send. */
      ? log.delete()
      : log.update({
          email_status: emailStatus,
          whatsapp_status: waOutcome === "sent" || waOutcome === "failed" ? waOutcome : "skipped",
          whatsapp_skip_reason: waOutcome === "sent" || waOutcome === "failed" ? null : waOutcome,
          error: error?.slice(0, 500) ?? null,
          sent_at: new Date().toISOString(),
        })
    ).eq("tenant_id", tenantId).eq("user_id", d.person.id).eq("digest_date", today).eq("kind", d.kind);
    if (logErr) result.errors.push({ tenant: tenantId, message: `task digest log row not updated: ${logErr.message}` });

    if (emailStatus === "failed") {
      result.failed += 1;
      result.errors.push({ tenant: tenantId, message: `email to ${d.kind === "owner_summary" ? "the owner" : "a team member"} failed: ${error ?? "unknown"}` });
    } else {
      result.sent += 1;
    }
    result.details.push({ ...base, email: emailStatus, whatsapp: waOutcome });
  }

  await mapLimit(tenantIds, TENANTS_AT_ONCE, async (tenantId) => {
    try {
      const plan = planTaskDigests({
        today,
        people: peopleByTenant.get(tenantId) ?? [],
        tasks: tasksByTenant.get(tenantId) ?? [],
      });
      result.not_reachable += plan.skipped.length;
      for (const d of [...plan.personal, ...plan.ownerSummaries]) await sendOne(tenantId, d);
    } catch (e) {
      /* One company's failure must not stop every other company's digests. */
      result.errors.push({ tenant: tenantId, message: errorMessage(e) });
    }
  });

  if (tenantsWithoutTemplate.size > 0) {
    const n = tenantsWithoutTemplate.size;
    result.whatsapp_note =
      `WhatsApp copy not set up for ${n} compan${n === 1 ? "y" : "ies"} — email only. ` +
      `To get it on WhatsApp too, get a template named "${DIGEST_WA_TEMPLATE}" approved under Marketing → WhatsApp → Templates, ` +
      `with exactly three values: "${DIGEST_WA_TEMPLATE_BODY}"`;
  }

  return NextResponse.json(reportCron("task-digest", result));
}
