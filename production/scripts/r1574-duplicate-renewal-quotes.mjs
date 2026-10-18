/**
 * R-1574 — renewal quotes made twice for one subscription. REPORT ONLY: this script never writes.
 *
 * Until R-1574 a renewal quote was made in three separate calls (number → insert → link), so two
 * overlapping runs (cron + "Generate renewal quote", or a retry) could each make one. Only the
 * last one stayed linked (subscriptions.renewal_quote_id). Paying an UNLINKED one was treated by
 * record_payment as a NEW sale: a second subscription was opened and the real one was not renewed.
 * From the R-1574 migration on, create_renewal_quote makes and links in one transaction, once per
 * subscription term — but quotes made before it carry no term, so what is already in the data is
 * listed here for a person to decide.
 *
 *   REPAIR_DATABASE_URL=postgresql://… node scripts/r1574-duplicate-renewal-quotes.mjs
 *   REPAIR_DATABASE_URL=postgresql://… node scripts/r1574-duplicate-renewal-quotes.mjs --tenant <uuid>
 *
 * Two lists:
 *   A. DUPLICATE OPEN — a subscription with more than one open renewal quote (sent/viewed/accepted,
 *      not paid, not superseded). The linked one is marked; the others are the danger: if the
 *      customer pays one of them, a new subscription opens instead of the renewal.
 *      Decision per row (owner): reject the unlinked quote(s), or tell the customer which to pay.
 *   B. PAID UNLINKED — a renewal quote that was paid while no subscription pointed at it, and so
 *      opened a subscription of its own (subscriptions.quote_id = that renewal quote). The original
 *      subscription was NOT renewed. Decision per row (owner + accounts): roll the original
 *      subscription forward and close the duplicate, or keep both — money already moved, so this
 *      is never a script's call.
 *
 * A quote is tied to its subscription by quotes.renewal_subscription_id (R-1574 on), else by the
 * subscription's renewal_quote_id, else by "subscription <uuid>" in its notes — every renewal quote
 * the app has made carries that (same rule as app/(app)/renewals/open-renewal-quotes.ts).
 * Read-only: one SELECT per list inside a READ ONLY transaction.
 */
import pg from "pg";

const url = process.env.REPAIR_DATABASE_URL;
const tIdx = process.argv.indexOf("--tenant");
const TENANT = tIdx > 0 ? process.argv[tIdx + 1] : null;

if (process.argv.includes("--apply")) {
  console.error("This script only reports. Fixing duplicates is the owner's decision (see card R-1574).");
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

/* Which subscription a renewal quote belongs to (see header). renewal_subscription_id exists only
   after the R-1574 migration; to_jsonb(q) reads it when present and null before. */
const QUOTE_SUB = `
  coalesce(
    nullif(to_jsonb(q)->>'renewal_subscription_id', '')::uuid,
    (select s.id from public.subscriptions s where s.tenant_id = q.tenant_id and s.renewal_quote_id = q.id limit 1),
    nullif(substring(q.notes from 'subscription ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'), '')::uuid
  )`;

const db = new pg.Client({ connectionString: url });
try { await db.connect(); } catch (e) {
  console.error(`Could not connect to REPAIR_DATABASE_URL: ${e.code ?? e.message}`);
  process.exit(1);
}
try {
  await db.query("begin read only");

  const { rows: dup } = await db.query(
    `with rq as (
       select q.id, q.tenant_id, q.amount, q.created_date::text as created_date, q.status::text as status,
              q.payment_status::text as payment_status, ${QUOTE_SUB} as sub_id
         from public.quotes q
        where q.is_renewal
          and coalesce(q.is_extension, false) = false
          and q.status::text in ('sent', 'viewed', 'accepted')
          and coalesce(q.payment_status::text, 'none') in ('none', 'awaiting', 'partial')
          and q.superseded_by is null
          and ($1::uuid is null or q.tenant_id = $1::uuid)
     )
     select s.id as sub_id, s.tenant_id, s.customer_name, s.plan, s.renewal_date::text as renewal_date,
            s.renewal_quote_id,
            json_agg(json_build_object('id', rq.id, 'amount', rq.amount, 'created', rq.created_date,
                                       'status', rq.status, 'payment', rq.payment_status,
                                       'linked', rq.id = s.renewal_quote_id)
                     order by rq.created_date, rq.id) as quotes
       from rq
       join public.subscriptions s on s.id = rq.sub_id and s.tenant_id = rq.tenant_id
      group by s.id
     having count(*) > 1
      order by s.renewal_date nulls last, s.customer_name`,
    [TENANT],
  );

  const { rows: paid } = await db.query(
    `select q.id as quote_id, q.tenant_id, q.amount, q.customer_name, q.payment_status::text as payment_status,
            ${QUOTE_SUB} as original_sub_id,
            (select json_agg(json_build_object('id', d.id, 'plan', d.plan, 'renewal_date', d.renewal_date::text, 'status', d.status::text))
               from public.subscriptions d where d.tenant_id = q.tenant_id and d.quote_id = q.id) as opened_subs
       from public.quotes q
      where q.is_renewal
        and coalesce(q.is_extension, false) = false
        and q.payment_status::text in ('received', 'invoiced', 'partial')
        and exists (select 1 from public.subscriptions d where d.tenant_id = q.tenant_id and d.quote_id = q.id)
        and ($1::uuid is null or q.tenant_id = $1::uuid)
      order by q.created_date, q.id`,
    [TENANT],
  );

  await db.query("rollback");

  console.log(`R-1574 duplicate renewal quotes — REPORT ONLY${TENANT ? ` (tenant ${TENANT})` : ""}\n`);
  console.log(`A. DUPLICATE OPEN: ${dup.length} subscription(s) with more than one open renewal quote`);
  for (const r of dup) {
    console.log(`  - ${r.customer_name} · ${r.plan} · renews ${r.renewal_date} · sub ${r.sub_id} (tenant ${r.tenant_id})`);
    for (const q of r.quotes) {
      console.log(`      ${q.linked ? "LINKED  " : "unlinked"} ${q.id}  ₹${q.amount}  ${q.created}  ${q.status}/${q.payment}`);
    }
  }
  console.log(`\nB. PAID UNLINKED: ${paid.length} renewal quote(s) paid as a NEW sale (opened their own subscription)`);
  for (const r of paid) {
    const opened = (r.opened_subs ?? []).map((d) => `${d.id} (${d.plan}, ${d.status}, renews ${d.renewal_date})`).join("; ");
    console.log(`  - ${r.quote_id} · ${r.customer_name} · ₹${r.amount} · ${r.payment_status}`);
    console.log(`      meant to renew: ${r.original_sub_id ?? "(unknown — no link, no subscription id in notes)"}`);
    console.log(`      opened instead: ${opened}`);
  }
  console.log("\nNothing was written. Each row needs the owner's decision — see card R-1574 (needsDecision).");
} catch (e) {
  console.error(`Query failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
