/**
 * R-1562 — subscriptions stuck in renewal_state = 'renewed'. DRY RUN by default.
 *
 * Until R-1562, 'renewed' was a dead end: record_payment wrote it when a renewal quote was
 * paid (and rolled renewal_date one term on), and the renewals cron never moved off it — so
 * the NEXT term got no reminder, no renewal quote and no grace/suspend.
 *
 * After R-1562 the cron re-opens the ladder by itself once the new term's first reminder is
 * due (T-30; T-7 on a one-month term). Nothing has to be written for that. This script
 * shows, BEFORE the first post-deploy cron run, what that run will do to every stuck row:
 *
 *   settled      — renewed, next reminder not due yet. The cron leaves it alone (correct).
 *   rearm        — renewed, the new term's ladder has begun. The cron sets 'pending' and
 *                  sends the reminder that is due (catch-up rule) with a renewal quote.
 *   past_due     — renewed, renewal_date already PAST: the term ended with no reminder at
 *                  all. The cron sends a final notice (inside grace: the grace notice) and,
 *                  if still unpaid, suspends on a LATER run. These need the owner's decision
 *                  (move the date, call the customer, or let the cron proceed).
 *
 *   REPAIR_DATABASE_URL=postgresql://… node scripts/renewed-state-repair.mjs            # dry run
 *   REPAIR_DATABASE_URL=postgresql://… node scripts/renewed-state-repair.mjs --apply    # rearm rows only
 *
 * --apply writes ONLY the "rearm" group (renewed → pending, guarded on the state and date
 * that were read), so the Renewals screen and Today inbox show them before the cron runs.
 * It never touches "past_due" rows — that is the owner's call, not a script's. Optional
 * --tenant <uuid> limits the run to one tenant. Read-only without --apply.
 */
import pg from "pg";

const url = process.env.REPAIR_DATABASE_URL;
const APPLY = process.argv.includes("--apply");
const tIdx = process.argv.indexOf("--tenant");
const TENANT = tIdx > 0 ? process.argv[tIdx + 1] : null;

if (!url) {
  console.error("REPAIR_DATABASE_URL is not set. Point it at the database to inspect (local first).");
  process.exit(2);
}
if (TENANT && !/^[0-9a-f-]{36}$/i.test(TENANT)) {
  console.error(`--tenant must be a uuid, got "${TENANT}"`);
  process.exit(2);
}

/* Mirrors lib/renewals/cadence.ts: first reminder at T-30, or T-7 on a one-month term. */
const firstTrigger = (termMonths) => (termMonths === 1 ? 7 : 30);

const db = new pg.Client({ connectionString: url });
try { await db.connect(); } catch (e) {
  console.error(`Could not connect to REPAIR_DATABASE_URL: ${e.code ?? e.message}`);
  process.exit(1);
}
try {
  const { rows } = await db.query(
    `select s.id, s.tenant_id, s.customer_name, s.plan, s.renewal_date::text as renewal_date,
            s.term_months, s.billing_cycle, s.renewal_quote_id,
            coalesce(t.grace_period_days, 0) as grace_days,
            (s.renewal_date - (now() at time zone 'Asia/Kolkata')::date) as days_until
       from public.subscriptions s
       join public.tenants t on t.id = s.tenant_id
      where s.renewal_state = 'renewed'
        and s.status = 'active'
        and s.auto_renew = true
        and s.renewal_date is not null
        and ($1::uuid is null or s.tenant_id = $1::uuid)
      order by s.renewal_date, s.id`,
    [TENANT],
  );

  /* Billed-in-parts terms (monthly/quarterly/half-yearly invoicing) never use the ladder —
     the cron rolls them on their own (R-808). Listed, never touched. */
  const splitBilled = (r) => ["monthly", "quarterly", "half_yearly"].includes(r.billing_cycle);  // lib/billing/instalments.ts SPLIT_CYCLES

  const groups = { settled: [], rearm: [], past_due: [], split_billed: [] };
  for (const r of rows) {
    const d = Number(r.days_until);
    if (splitBilled(r)) groups.split_billed.push(r);
    else if (d < 0) groups.past_due.push(r);
    else if (d <= firstTrigger(r.term_months)) groups.rearm.push(r);
    else groups.settled.push(r);
  }

  const line = (r, next) =>
    `  ${r.id}  ${String(r.customer_name ?? "").slice(0, 28).padEnd(28)}  ${r.renewal_date}  ` +
    `d=${String(r.days_until).padStart(5)}  term=${r.term_months ?? 12}m  renewed -> ${next}`;

  console.log(`Stuck in 'renewed' (active, auto-renew): ${rows.length}${TENANT ? ` (tenant ${TENANT})` : ""}\n`);
  console.log(`settled — nothing due yet, cron leaves them: ${groups.settled.length}`);
  for (const r of groups.settled) console.log(line(r, `renewed (re-opens at T-${firstTrigger(r.term_months)})`));
  console.log(`\nrearm — new term's reminders are due; cron re-opens them: ${groups.rearm.length}`);
  for (const r of groups.rearm) console.log(line(r, "pending (+ reminder that is due, with a renewal quote)"));
  console.log(`\npast_due — term ENDED with no reminder; OWNER DECIDES: ${groups.past_due.length}`);
  for (const r of groups.past_due) {
    const inGrace = -Number(r.days_until) <= Number(r.grace_days);
    console.log(line(r, inGrace ? "grace_period (grace notice)" : "final_sent (final notice), suspend on a later run if unpaid"));
  }
  console.log(`\nsplit_billed — billed in parts, rolled by the cron, not a ladder: ${groups.split_billed.length}`);
  for (const r of groups.split_billed) console.log(line(r, "unchanged"));

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. --apply sets ONLY the 'rearm' rows to 'pending'.");
    process.exitCode = 0;
  } else {
    await db.query("begin");
    let n = 0;
    for (const r of groups.rearm) {
      const res = await db.query(
        `update public.subscriptions
            set renewal_state = 'pending'
          where id = $1 and renewal_state = 'renewed' and renewal_date = $2::date`,
        [r.id, r.renewal_date],
      );
      n += res.rowCount ?? 0;
    }
    await db.query("commit");
    console.log(`\nAPPLIED: ${n} row(s) renewed -> pending. past_due rows untouched (${groups.past_due.length}).`);
  }
} catch (e) {
  try { await db.query("rollback"); } catch { /* not in a transaction */ }
  console.error("repair failed:", e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
