#!/usr/bin/env node
/**
 * R-2626 local test data — a subscription billed MONTHLY whose NEXT month already has a proforma at
 * the old plan's rate (as Renewals → Bill next part leaves it), so Change plan is refused.
 *
 *   node scripts/dev/r2626-later-part.mjs           (re)load it into E2E Test Co
 *   node scripts/dev/r2626-later-part.mjs --clear   remove it
 *
 * Customer "CT R2626 Parts Co", subscription "CT R2626 Monthly Starter": E2E Google Workspace Business
 * Starter, 10 seats × ₹3,240/yr (₹2,700 a month), annual commitment billed monthly from the 1st two
 * months ago. This month's part is invoiced and paid (INV-CT2626-3, ₹3,186), next month's part has
 * proforma PI-CT2626-4 (sent, ₹3,186, unpaid). Used by the R-2626 card test (e2e/cards/R-2626.spec.ts).
 *
 * LOCAL docker DB only — refuses (exit 1) like scenario.mjs when the app does not read the local DB.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioTargetReason } from "./local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../../e2e/fixtures/e2e-roles.mjs";

const PROD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const R2626 = {
  customer: "c2626000-0000-4000-8000-000000000001",
  sub: "c2626000-0000-4000-8000-000000000002",
  part3: "c2626000-0000-4000-8000-000000000013",
  part4: "c2626000-0000-4000-8000-000000000014",
  invoice: "INV-CT2626-3",
  proforma: "PI-CT2626-4",
  plan: "CT R2626 Monthly Starter",
  name: "CT R2626 Parts Co",
};

function container() {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env = {};
  const f = path.join(PROD, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`r2626-later-part refuses to write test data: ${why ?? "no local DB container"}`);
  return c;
}

function psql(c, sql) {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/* Like scenario.mjs (_common.sql scn_drop_customer_docs): a PAID test invoice cannot be deleted while the
   GST-series triggers run, so the clear runs with user triggers off on these tables, inside its own
   transaction, and turns them back on before commit. Local docker DB only (container() refuses otherwise). */
const TABLES = ["payments", "subscription_billings", "quotes", "subscriptions", "invoices", "customers"];

function clearSql(tenant) {
  const c = R2626.customer;
  return [
    ...TABLES.map((t) => `alter table public.${t} disable trigger user;`),
    `delete from public.payments where tenant_id = '${tenant}' and quote_id in (select id from public.quotes where tenant_id = '${tenant}' and customer_id = '${c}');`,
    `update public.subscriptions set renewal_quote_id = null where tenant_id = '${tenant}' and customer_id = '${c}';`,
    `delete from public.quotes where tenant_id = '${tenant}' and customer_id = '${c}';`,
    `delete from public.subscriptions where tenant_id = '${tenant}' and customer_id = '${c}';`,
    `delete from public.invoices where tenant_id = '${tenant}' and customer_id = '${c}';`,
    `delete from public.customers where tenant_id = '${tenant}' and id = '${c}';`,
  ];
}

export function loadR2626({ clear = false } = {}) {
  const c = container();
  const t = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (t.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${t.length}`);
  const tenant = t[0].trim();
  if (clear) {
    psql(c, ["begin;", "select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);", ...clearSql(tenant), "commit;"].join("\n"));
    return;
  }
  const start = "(date_trunc('month', current_date) - interval '2 months')::date";
  const m = (n) => `(date_trunc('month', current_date) + interval '${n} months')::date`;
  psql(c, [
    "begin;",
    "select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true);",
    ...clearSql(tenant),
    `insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, contact_name, notes) values
      ('${R2626.customer}', '${tenant}', '${R2626.name}', 'Maharashtra', '27', 'India', 'business', 'Neha Joshi', 'R-2626 card test data');`,
    `insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, item_id, seats, mrr, billing_cycle,
                                       term_months, start_date, renewal_date, status, domain, auto_renew) values
      ('${R2626.sub}', '${tenant}', '${R2626.customer}', '${R2626.name}', '${R2626.plan}', 'google', 'E2E-GW-STR', 10, 2700,
       'monthly', 12, ${start}, ${m(10)} - 1, 'active', 'ct-r2626.example', true);`,
    `insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                                  taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items) values
      ('${R2626.invoice}', '${tenant}', '${R2626.customer}', '${R2626.name}', 3186, 'paid', ${m(0)}, ${m(0)} + 15,
       2700, 486, 18, true, 3186, 'tax_invoice',
       '[{"id": "line-1", "qty": 10, "cost": 0, "name": "E2E Google Workspace Business Starter (this month)", "rate": 270}]'::jsonb);`,
    `insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                               period_start, period_end, taxable_amount, tax_rate, invoice_id) values
      ('${R2626.part3}', '${tenant}', '${R2626.sub}', ${start}, 3, ${m(0)}, ${m(0)}, ${m(1)}, 2700, 18, '${R2626.invoice}'),
      ('${R2626.part4}', '${tenant}', '${R2626.sub}', ${start}, 4, ${m(1)}, ${m(1)}, ${m(2)}, 2700, 18, null);`,
    `insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate,
                                discount_pct, status, payment_status, created_date, expires_date, billing_cycle, currency,
                                line_items, notes, subscription_billing_id) values
      ('${R2626.proforma}', '${tenant}', '${R2626.customer}', '${R2626.name}', 'E2E Google Workspace Business Starter', 10,
       3186, 2700, 0, 18, 0, 'sent', 'awaiting', current_date, ${m(1)} + 14, 'monthly', 'INR',
       '[{"id": "line-1", "item_id": "E2E-GW-STR", "qty": 10, "cost": 0, "name": "E2E Google Workspace Business Starter — next month", "rate": 270}]'::jsonb,
       'R-2626 card test data — proforma raised ahead for next month', '${R2626.part4}');`,
    "commit;",
  ].join("\n"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const clear = process.argv.includes("--clear");
  try {
    loadR2626({ clear });
    console.log(clear ? "R-2626 test data removed." : `R-2626 test data loaded: ${R2626.name} → ${R2626.plan} (next month: proforma ${R2626.proforma}).`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
