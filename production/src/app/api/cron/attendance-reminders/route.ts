/**
 * /api/cron/attendance-reminders — push the attendance nudge to people's phones.
 *
 * ─── WHY A CRON AT ALL ──────────────────────────────────────────────────────
 * The reminder already exists, and it is mounted in (app)/layout.tsx — so it only fires
 * while somebody has ResellerOS open. The whole point of the feature is to catch a
 * forgotten check-in, which is exactly the state where the app is closed. Until this
 * route existed, the reminder could only reach people who did not need it.
 *
 * ─── THE DECISION IS NOT MADE HERE ──────────────────────────────────────────
 * `decideAttendanceReminder` from lib/attendance/reminders.ts decides, the same function
 * the popup uses, with its own 28 tests. Two copies of "is this person due a nudge" would
 * drift within a month and the phone and the screen would start disagreeing about the
 * same day.
 *
 * What this route deliberately does NOT pass is the dismissal and the snooze: those live
 * in localStorage on one device, so the server cannot see them. The consequence is honest
 * and bounded — somebody who dismissed the popup on their laptop may still get one push —
 * and the log below guarantees it is at most one.
 *
 * ─── SAFE TO RUN OFTEN ──────────────────────────────────────────────────────
 * Every send claims a row in attendance_reminder_log first, and a unique index on
 * (user_id, work_date, kind) makes a second attempt fail in the database. So Scheduler
 * retries, an overlapping deploy and a half-hourly schedule are all harmless. Run it
 * every 30 minutes; it will nudge each person at most twice a day.
 *
 * ─── DRY RUN ────────────────────────────────────────────────────────────────
 * `?dry=1` reports exactly who WOULD be pushed and why, and writes nothing. Same reason
 * the renewals cron has one: a job whose correct behaviour is usually "do nothing" cannot
 * otherwise be told apart from a job that is broken.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { fetchAllRows, fetchAllRowsIn, errorMessage } from "@/lib/ops/fetch-all";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { istNow, decideAttendanceReminder } from "@/lib/attendance/reminders";
import { isWorkingDay, SIX_DAY_WEEK_SUNDAY_OFF } from "@/lib/attendance/working-day";
import { sendPushToUsers } from "@/lib/push/send";
import { reportCron } from "@/lib/ops/cron-report";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Due {
  userId: string;
  tenantId: string;
  name: string | null;
  kind: "check_in" | "check_out";
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request) {
  /* Fail closed, exactly like the renewals cron: this route sends notifications under the
     service role, so an unconfigured secret must refuse rather than allow. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const isDry = new URL(req.url).searchParams.get("dry") === "1";
  const admin = createAdminClient();
  const now = istNow(new Date());

  /* Only people who could actually act on it: reminders on, and linked to an employee
     record. Nagging a login that cannot punch is how a reminder becomes something people
     close without reading. */
  /* WC-scale: paged (lib/ops/fetch-all.ts). One select stopped at PostgREST's 1000-row cap
     — across every tenant, user 1001 was never reminded. */
  let users: { id: string; tenant_id: string; full_name: string | null; employee_id: string | null; attendance_reminders_enabled: boolean | null; attendance_checkout_reminder_at: string | null }[];
  try {
    users = await fetchAllRows((from, to) => admin
      .from("users")
      .select("id, tenant_id, full_name, employee_id, attendance_reminders_enabled, attendance_checkout_reminder_at")
      .eq("attendance_reminders_enabled", true)
      .not("employee_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to));
  } catch (e) {
    return cronDbFailure("attendance-reminders", e, `could not read users: ${errorMessage(e)}`);
  }

  const employeeIds = users.map((u) => u.employee_id).filter((x): x is string => Boolean(x));
  /* One query for the whole tenant's day rather than one per person: this runs every
     half hour and a per-user round trip would be the slow kind of correct. 200 ids a
     request so the url stays bounded. A failed read is loud now — read as "nobody checked
     in", it would have nagged everybody who had. */
  let today: { employee_id: string; check_in: string | null; check_out: string | null }[];
  try {
    today = await fetchAllRowsIn(employeeIds, (ids, from, to) => admin
      .from("attendance")
      .select("employee_id, check_in, check_out")
      .eq("work_date", now.date)
      .in("employee_id", ids)
      .order("id", { ascending: true })
      .range(from, to));
  } catch (e) {
    return NextResponse.json({ error: `could not read attendance: ${errorMessage(e)}` }, { status: 500 });
  }

  const byEmployee = new Map(today.map((r) => [r.employee_id, r]));

  /* ── Is anybody due a check-in today at all? ──────────────────────────────
     Reported 23 Aug 2026, a Sunday: nothing in this path knew what a working day was, so
     the nudge went out every Sunday and on every public holiday — while `public.holidays`
     had stored them all along.

     Saturday IS a working day here, confirmed by the operator, so the week is six days
     with Sunday off. That is a business fact rather than a default — Indian SMEs run
     six-day, five-day and alternate-Saturday weeks — which is why the shape is a named
     constant and not an inline literal.

     Resolved PER TENANT. The users query above has no tenant filter, by design, since one
     Scheduler hit must cover all of them — so a single working-day answer would apply one
     company's holiday calendar to another company's staff. One query for every tenant's
     holidays today, then a lookup per person. */
  const tenantIds = [...new Set(users.map((u) => u.tenant_id).filter(Boolean))];
  const holidayRows = await fetchAllRowsIn(tenantIds, (ids, from, to) => admin
    .from("holidays")
    .select("tenant_id, holiday_date")
    .in("tenant_id", ids)
    .eq("holiday_date", now.date)
    .order("id", { ascending: true })
    .range(from, to)).catch(() => [] as { tenant_id: string; holiday_date: string }[]);

  const holidaysByTenant = new Map<string, string[]>();
  for (const h of (holidayRows ?? []) as { tenant_id: string; holiday_date: string }[]) {
    const list = holidaysByTenant.get(h.tenant_id) ?? [];
    list.push(h.holiday_date);
    holidaysByTenant.set(h.tenant_id, list);
  }

  /* Memoised per tenant: isWorkingDay is cheap, but computing it inside the loop would
     make the reason string differ per user for no reason and read as if it could. */
  const workingDayFor = (tid: string) => isWorkingDay({
    date: now.date,
    weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF,
    holidayDates: holidaysByTenant.get(tid) ?? [],
  });

  const due: Due[] = [];
  const skipped: { userId: string; reason: string }[] = [];

  for (const u of users) {
    const row = u.employee_id ? byEmployee.get(u.employee_id) : undefined;
    const decision = decideAttendanceReminder({
      now,
      linked: true,
      checkIn:  row?.check_in ?? null,
      checkOut: row?.check_out ?? null,
      enabled:  true,
      checkoutReminderAt: u.attendance_checkout_reminder_at ?? null,
      nonWorkingDayReason: workingDayFor(u.tenant_id).reason,
      /* dismissed / snoozedUntilMin / onAttendanceScreen are localStorage facts on one
         device. The server cannot see them, so it does not pretend to. */
    });
    if (!decision.kind) {
      skipped.push({ userId: u.id, reason: decision.reason });
      continue;
    }
    due.push({ userId: u.id, tenantId: u.tenant_id, name: u.full_name, kind: decision.kind });
  }

  if (isDry) {
    /* A dry run has to answer "what would happen", not "who is due" — and those differ by
       everybody already reminded today. Reported as `due: 4` while a live pass would push
       1, this output invited exactly the wrong conclusion, which was noticed by running
       the two back to back. So the log is read here too, and the dry run splits the list
       the same way the live path does. */
    const alreadyRows = await fetchAllRows((from, to) => admin
      .from("attendance_reminder_log")
      .select("user_id, kind")
      .eq("work_date", now.date)
      .order("id", { ascending: true })
      .range(from, to)).catch(() => [] as { user_id: string; kind: string }[]);
    const alreadyKeys = new Set(alreadyRows.map((r) => `${r.user_id}:${r.kind}`));
    const wouldPush = due.filter((d) => !alreadyKeys.has(`${d.userId}:${d.kind}`));
    const alreadyReminded = due.filter((d) => alreadyKeys.has(`${d.userId}:${d.kind}`));

    return NextResponse.json({
      dryRun: true,
      istNow: { date: now.date, minutes: now.minutes },
      considered: users.length,
      wouldPush,
      alreadyRemindedToday: alreadyReminded,
      skipped,
    });
  }

  let pushed = 0;
  let alreadyDone = 0;
  const failures: { userId: string; error: string }[] = [];

  for (const person of due) {
    /* Claim the slot BEFORE sending. A unique violation here means another run — or a
       Scheduler retry — already handled this person today, and skipping is the whole
       point of the constraint. */
    const { data: claimed, error: claimErr } = await admin
      .from("attendance_reminder_log")
      .insert({
        tenant_id: person.tenantId,
        user_id:   person.userId,
        work_date: now.date,
        kind:      person.kind,
      })
      .select("id")
      .single();

    if (claimErr) {
      /* 23505 = unique violation = already reminded. Anything else is a real problem. */
      if (claimErr.code === "23505") { alreadyDone += 1; continue; }
      failures.push({ userId: person.userId, error: claimErr.message });
      continue;
    }

    const result = await sendPushToUsers([person.userId], {
      kind: person.kind === "check_in" ? "attendance_checkin" : "attendance_checkout",
      name: person.name?.split(" ")[0] ?? null,
    });

    await admin
      .from("attendance_reminder_log")
      .update({
        sent_at: result.sent > 0 ? new Date().toISOString() : null,
        devices: result.sent,
        /* A claimed slot that sent nothing is recorded as such — otherwise it looks
           identical to a day when nobody was due. */
        error: result.sent > 0 ? null : (result.problem ?? `no device (attempted ${result.attempted})`),
      })
      .eq("id", claimed.id);

    if (result.sent > 0) pushed += 1;
    else failures.push({ userId: person.userId, error: result.problem ?? "no device reached" });
  }

  return NextResponse.json(reportCron("attendance-reminders", {
    istDate: now.date,
    considered: users.length,
    due: due.length,
    pushed,
    alreadyRemindedToday: alreadyDone,
    failures,
  }));
}
