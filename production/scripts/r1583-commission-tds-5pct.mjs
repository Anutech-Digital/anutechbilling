/**
 * R-1583 — partner commissions whose s.194H TDS was taken at 5% (the old default) instead of 2%.
 * DRY RUN / REPORT ONLY: this script never writes. What to do with them is Hitesh's / the CA's call
 * (card R-1583 needsDecision) — a commission already PAID had 5% withheld and possibly deposited
 * and shown in 26Q, so it is never a script's decision.
 *
 *   REPAIR_DATABASE_URL=postgresql://… node scripts/r1583-commission-tds-5pct.mjs
 *   REPAIR_DATABASE_URL=postgresql://… node scripts/r1583-commission-tds-5pct.mjs --tenant <uuid>
 *
 * Two lists:
 *   A. COMMISSIONS at 5%: every not-cancelled referral_commissions row whose TDS is 5% of the gross
 *      (to the rupee, or its agreement says 5) — partner, period (earned month), status, gross,
 *      TDS taken, TDS at 2%, difference (excess withheld from the partner).
 *   B. AGREEMENTS / PARTNERS still carrying 5: from R-1583 a NEW commission takes the agreement's own
 *      rate, so these will keep deducting 5% until someone changes them (they were stored as 5 by
 *      the old column default, which the database cannot tell apart from a rate typed on purpose).
 *
 * --apply is refused. Read-only: SELECTs inside a READ ONLY transaction.
 */
import pg from "pg";

const NEW_RATE = 2;   // TDS_SECTION_RATES["194H"] (src/lib/accounting/tds-rates.ts) = public.tds_194h_default_rate()
const OLD_RATE = 5;

const url = process.env.REPAIR_DATABASE_URL;
const tIdx = process.argv.indexOf("--tenant");
const TENANT = tIdx > 0 ? process.argv[tIdx + 1] : null;

if (process.argv.includes("--apply")) {
  console.error("This script only reports. Changing commissions already taken at 5% is Hitesh's / the CA's decision (card R-1583).");
  process.exit(2);
}
if (!url) {
  console.error("REPAIR_DATABASE_URL is not set. Point it at the database to inspect (local first).");
  process.exit(2);
}
if (TENANT && !/^[0-9a-f-]{36}$/i.test(TENANT)) {
  console.error(`--tenant must be a uuid, got "${TENANT}"`);
  process.exit(2);
}

const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");

const db = new pg.Client({ connectionString: url });
try { await db.connect(); } catch (e) {
  console.error(`Could not connect to REPAIR_DATABASE_URL: ${e.code ?? e.message}`);
  process.exit(1);
}
try {
  await db.query("begin read only");

  const { rows: comm } = await db.query(
    `select c.id, c.tenant_id, p.name as partner, p.pan, to_char(c.earned_date, 'YYYY-MM') as period,
            c.status, c.gross_commission as gross, c.tds_amount as tds,
            round(c.gross_commission * $2::numeric / 100)::int as tds_new,
            c.tds_amount - round(c.gross_commission * $2::numeric / 100)::int as diff
       from public.referral_commissions c
       join public.referral_partners p on p.id = c.partner_id
       left join public.referral_agreements a on a.id = c.agreement_id
      where c.status <> 'cancelled'
        and c.tds_amount > 0
        and (c.tds_amount = round(c.gross_commission * $3::numeric / 100)::int or a.tds_rate = $3)
        and ($1::uuid is null or c.tenant_id = $1::uuid)
      order by c.tenant_id, p.name, c.earned_date, c.id`,
    [TENANT, NEW_RATE, OLD_RATE],
  );

  const { rows: still } = await db.query(
    `select 'agreement' as kind, a.id, a.tenant_id, p.name as partner, a.status, a.deduct_tds
       from public.referral_agreements a join public.referral_partners p on p.id = a.partner_id
      where a.tds_rate = $2 and a.status = 'active' and ($1::uuid is null or a.tenant_id = $1::uuid)
     union all
     select 'partner', p.id, p.tenant_id, p.name, case when p.is_active then 'active' else 'inactive' end, p.deduct_tds
       from public.referral_partners p
      where p.tds_rate = $2 and ($1::uuid is null or p.tenant_id = $1::uuid)
      order by 3, 4, 1`,
    [TENANT, OLD_RATE],
  );

  await db.query("rollback");

  console.log(`R-1583 partner commission TDS at ${OLD_RATE}% instead of ${NEW_RATE}% — DRY RUN, nothing written${TENANT ? ` (tenant ${TENANT})` : ""}\n`);
  console.log(`A. COMMISSIONS at ${OLD_RATE}%: ${comm.length}`);
  let total = 0;
  for (const r of comm) {
    total += r.diff;
    console.log(`  - ${r.partner}${r.pan ? ` (PAN ${r.pan})` : ""} · ${r.period} · ${r.status} · gross ${inr(r.gross)} · TDS ${OLD_RATE}% ${inr(r.tds)} vs ${NEW_RATE}% ${inr(r.tds_new)} · difference ${inr(r.diff)}  [${r.id}, tenant ${r.tenant_id}]`);
  }
  console.log(`  Total excess withheld: ${inr(total)}`);
  console.log(`\nB. ACTIVE AGREEMENTS / PARTNERS still at ${OLD_RATE}% (new commissions on them keep taking ${OLD_RATE}%): ${still.length}`);
  for (const r of still) {
    console.log(`  - ${r.kind} ${r.id} · ${r.partner} · ${r.status} · deduct TDS ${r.deduct_tds ? "yes" : "no"} (tenant ${r.tenant_id})`);
  }
  console.log("\nNothing was written. Hitesh / CA decides per row — see card R-1583 (needsDecision).");
} catch (e) {
  console.error(`Query failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
