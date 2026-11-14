#!/usr/bin/env node
/**
 * R-2768 — PROOF for the two owner-approved data repairs, on the LOCAL Docker DB only.
 *
 * It runs the real repair functions (migration 20261114043932) inside ONE transaction and compares,
 * with the app's OWN TypeScript (not a SQL copy), what every surface shows BEFORE vs AFTER:
 *
 *   A (line periods) — for EVERY issued invoice made from a quote (pending / paid / overdue):
 *       the server PDF  : buildInvoicePdfProps(...) → each printed line + lineDetailNotes(line, ctx)
 *       the invoice page: quote.line_items ?? invoice.line_items → withStoredLinePeriods → lineDetailNotes
 *     (subscription facts + app_rule_dates exactly as the PDF route / useQuotePeriodContext read them).
 *     Must be 0 differences.
 *   B (quote notes) — the Renewals page map (useOpenRenewalQuotes rows → openRenewalQuoteMap) and the
 *     add-seats link (seat-quotes-pending SUB_IN_NOTES) for every quote: identical before / after;
 *     every rewritten quote's customer text (PDF path without ctx, accept page with ctx) has no id.
 *
 * Default: ROLLBACK (nothing changes). `--commit` keeps the repair (local only).
 * Refuses any database that is not local (scripts/dev/local-guard.mjs).
 *
 *   cd production
 *   node scripts/ops/r2768-repair-proof.mjs            # proof, rolled back
 *   node scripts/ops/r2768-repair-proof.mjs --commit   # proof, then keep it on local
 *
 * DB: R2768_DB_URL, else the local Supabase default postgresql://postgres:postgres@127.0.0.1:54322/postgres.
 * Exit 0 = proof held (0 differences); 1 = a difference (rolled back, whatever the flag).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { dbUrlLocalReason } from "../dev/local-guard.mjs";

const root = process.cwd();
const req = createRequire(path.join(root, "package.json"));
const commit = process.argv.includes("--commit");
const url = process.env.R2768_DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const notLocal = dbUrlLocalReason(url);
if (notLocal) {
  console.error(`RUKA — ${notLocal}. This proof runs on the local Docker DB only.`);
  process.exit(2);
}

const jiti = req("jiti")(path.join(root, "package.json"), { alias: { "@": path.join(root, "src") }, interopDefault: true, esmResolve: true });
const { buildInvoicePdfProps } = jiti(path.join(root, "src/lib/pdf/build-props.ts"));
const { lineDetailNotes } = jiti(path.join(root, "src/lib/pdf/invoice-display.ts"));
const { withStoredLinePeriods } = jiti(path.join(root, "src/lib/quotes/stored-line-period.ts"));
const { quoteLinePeriodContext, invoicePeriodSubscription, renewedSubscription, R2727_PERIOD_RULE_KEY } =
  jiti(path.join(root, "src/lib/quotes/service-period.ts"));
const { customerQuoteNotes } = jiti(path.join(root, "src/lib/quotes/customer-notes.ts"));
const { openRenewalQuoteMap } = jiti(path.join(root, "src/app/(app)/renewals/open-renewal-quotes.ts"));

const { Client } = req("pg");
const db = new Client({ connectionString: url });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SUB_IN_NOTES = /subscription ([0-9a-fA-F-]{36})/;
const TENANT = { name: "T", gstin: null, email: null, phone: null, address: null, state: null, state_code: "07" };
const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
/** A printed line: what the customer reads of it (internal cost keys and the stored value itself left out). */
const shown = (l, ctx) => {
  const { cost, cost_source, service_period, ...rest } = l ?? {};
  void cost; void cost_source; void service_period;
  return { ...rest, notes: lineDetailNotes(l ?? {}, ctx) };
};

async function invoiceViews() {
  const rule = (await db.query("select from_at from public.app_rule_dates where key = $1", [R2727_PERIOD_RULE_KEY]).catch(() => ({ rows: [] }))).rows[0];
  const ruleFrom = iso(rule?.from_at);
  /* The quote exactly as the PDF route (admin .eq("invoice_id", id).maybeSingle()) and the invoice page
     (useQuoteByInvoiceId) load it: by quotes.invoice_id, no tenant filter; two rows = maybeSingle error = none. */
  const { rows } = await db.query(`
    select to_jsonb(i) as invoice,
           case when (select count(*) from public.quotes q where q.invoice_id = i.id) = 1
                then (select to_jsonb(q) from public.quotes q where q.invoice_id = i.id) end as quote
      from public.invoices i
     where i.quote_id is not null and i.status::text in ('pending', 'paid', 'overdue')
     order by i.id`);
  const subsByCustomer = new Map();
  /* useCustomerSubscriptions: the customer's rows, start_date desc (Postgres DESC = nulls first). */
  const { rows: subs } = await db.query(
    "select id, tenant_id, customer_id, renewal_quote_id, domain, start_date::text, term_months from public.subscriptions order by start_date desc, id");
  for (const s of subs) {
    const k = `${s.tenant_id}|${s.customer_id}`;
    if (!subsByCustomer.has(k)) subsByCustomer.set(k, []);
    subsByCustomer.get(k).push(s);
  }
  const out = new Map();
  for (const { invoice, quote } of rows) {
    if (!quote) {
      // no quote on either surface: both print the invoice's own lines (and a stamp would add periods)
      const pdf = buildInvoicePdfProps({ invoice, quote: null, customer: null, tenant: TENANT, subscriptionDomain: null, periodRuleFrom: ruleFrom });
      const screen = withStoredLinePeriods(invoice.line_items ?? [], invoice, null);
      out.set(invoice.id, JSON.stringify({
        pdf: (pdf.lineItems ?? []).map((l) => shown(l, pdf.periodContext)),
        screen: (screen.lines ?? []).map((l) => shown(l, screen.ctx)),
      }));
      continue;
    }
    const needsSub = !!(quote.is_renewal || quote.is_extension);
    const custSubs = quote.customer_id ? (subsByCustomer.get(`${quote.tenant_id}|${quote.customer_id}`) ?? []) : [];
    // PDF route: loadRenewedSubscription (renewal_subscription_id, else renewal_quote_id) within the tenant
    const tenantSubs = subs.filter((s) => s.tenant_id === invoice.tenant_id);
    const pdfSub = !needsSub ? null : quote.renewal_subscription_id
      ? tenantSubs.find((s) => s.id === quote.renewal_subscription_id)
      : tenantSubs.find((s) => s.renewal_quote_id === quote.id);
    const facts = pdfSub ? { domain: (pdfSub.domain ?? "").trim() || null, start_date: pdfSub.start_date ?? null, term_months: pdfSub.term_months ?? null } : null;
    const pdf = buildInvoicePdfProps({ invoice, quote, customer: null, tenant: TENANT, subscriptionDomain: facts, periodRuleFrom: ruleFrom });
    const pdfLines = (pdf.lineItems ?? []).map((l) => shown(l, pdf.periodContext));
    // invoice page: useQuotePeriodContext (the customer's subscriptions)
    const screenSub = needsSub ? renewedSubscription(quote, custSubs) : null;
    const screenCtx = quoteLinePeriodContext(quote, invoicePeriodSubscription(invoice, ruleFrom, quote, screenSub));
    const screen = withStoredLinePeriods(quote.line_items ?? invoice.line_items ?? [], invoice, screenCtx);
    const screenLines = (screen.lines ?? []).map((l) => shown(l, screen.ctx));
    out.set(invoice.id, JSON.stringify({ pdf: pdfLines, screen: screenLines }));
  }
  return out;
}

async function quoteViews() {
  const { rows: open } = await db.query(`
    select id, notes, status::text as status from public.quotes
     where is_renewal = true and status::text in ('draft', 'sent', 'viewed', 'accepted')
       and payment_status::text in ('none', 'awaiting', 'partial')
     order by created_at desc, id desc`);
  const renewalMap = JSON.stringify([...openRenewalQuoteMap(open).entries()].sort());
  const { rows } = await db.query("select id, notes, line_items, plan, extension_months from public.quotes where notes is not null order by id");
  const per = new Map();
  for (const q of rows) {
    const lines = Array.isArray(q.line_items) ? q.line_items : [];
    per.set(q.id, {
      notes: q.notes,
      seatLink: q.notes.match(SUB_IN_NOTES)?.[1] ?? null,
      pdf: customerQuoteNotes(q.notes, lines),
      accept: customerQuoteNotes(q.notes, lines, { plan: q.plan, extensionMonths: q.extension_months }),
    });
  }
  return { renewalMap, per };
}

await db.connect();
let failed = false;
try {
  const who = (await db.query("select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass, (select count(*) from public.tenants)::int as tenants")).rows[0];
  console.log(`target: LOCAL ${new URL(url).host} · login ${who.u} · bypasses RLS ${who.bypass} · tenants ${who.tenants}`);
  await db.query("begin");
  const invBefore = await invoiceViews();
  const qBefore = await quoteViews();

  const a = (await db.query("select public.r2768_repair_invoice_line_periods(true) as r")).rows[0].r;
  const b = (await db.query("select public.r2768_repair_quote_notes(true) as r")).rows[0].r;
  console.log("A:", JSON.stringify(a.plan), "changed", a.changed);
  console.log("B:", JSON.stringify(b.plan), "changed", b.changed);

  const invAfter = await invoiceViews();
  const qAfter = await quoteViews();

  // A — every invoice prints the same, PDF and screen
  const changedInv = (await db.query("select row_id from public.r2768_repair_log where run_id = $1", [a.run_id])).rows.map((r) => r.row_id);
  let invDiff = 0;
  for (const [id, before] of invBefore) {
    if (invAfter.get(id) !== before) {
      invDiff++;
      if (invDiff <= 5) console.log(`  A DIFF ${id}\n    before ${before}\n    after  ${invAfter.get(id)}`);
    }
  }
  const stampedNow = (await db.query(
    "select count(*)::int as n from public.invoices i where i.id = any($1) and not exists (select 1 from jsonb_array_elements(i.line_items) l where not (l ? 'service_period'))",
    [changedInv])).rows[0].n;
  const withPeriod = changedInv.filter((id) => (invAfter.get(id) ?? "").includes("Subscription period:")).length;
  console.log(`A proof: ${invBefore.size} issued quote invoices compared (PDF + screen), ${changedInv.length} stamped (${stampedNow} carry the key on every line; ${withPeriod} print a "Subscription period:" line), differences ${invDiff}`);

  // B — renewals map + add-seats link identical; no id for the customer on rewritten quotes
  const changedQ = (await db.query("select row_id from public.r2768_repair_log where run_id = $1", [b.run_id])).rows.map((r) => r.row_id);
  let linkDiff = 0, idLeft = 0, pdfTextChanged = 0, acceptTextChanged = 0;
  for (const [id, x] of qBefore.per) {
    const y = qAfter.per.get(id);
    if (x.seatLink !== y.seatLink) linkDiff++;
  }
  for (const id of changedQ) {
    const x = qBefore.per.get(id), y = qAfter.per.get(id);
    if (UUID.test(y.notes.split("Staff only (not shown to the customer):")[0]) || UUID.test(y.pdf ?? "") || UUID.test(y.accept ?? "")) idLeft++;
    if (x.pdf !== y.pdf) pdfTextChanged++;
    if (x.accept !== y.accept) acceptTextChanged++;
  }
  const mapSame = qBefore.renewalMap === qAfter.renewalMap;
  console.log(`B proof: ${changedQ.length} quotes rewritten · Renewals open-quote map identical ${mapSame} · add-seats links moved ${linkDiff} · ids left for the customer ${idLeft} · customer text changed (PDF ${pdfTextChanged}, accept page ${acceptTextChanged})`);

  // idempotent
  const a2 = (await db.query("select public.r2768_repair_invoice_line_periods(true) as r")).rows[0].r;
  const b2 = (await db.query("select public.r2768_repair_quote_notes(true) as r")).rows[0].r;
  console.log(`second run: A changed ${a2.changed}, B changed ${b2.changed}`);

  failed = invDiff > 0 || !mapSame || linkDiff > 0 || idLeft > 0 || pdfTextChanged > 0 || acceptTextChanged > 0
    || a2.changed !== 0 || b2.changed !== 0;
  if (failed || !commit) {
    await db.query("rollback");
    console.log(failed ? "PROOF FAILED — rolled back, nothing changed." : "PROOF OK — rolled back (dry run). Use --commit to keep it on local.");
  } else {
    await db.query("commit");
    console.log(`PROOF OK — COMMITTED on local. Undo: select public.r2768_undo('${a.run_id}'); select public.r2768_undo('${b.run_id}');`);
  }
} catch (e) {
  failed = true;
  await db.query("rollback").catch(() => {});
  console.error("ERROR — rolled back:", e.message);
} finally {
  await db.end();
}
process.exit(failed ? 1 : 0);
