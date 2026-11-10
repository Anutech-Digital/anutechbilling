#!/usr/bin/env node
/**
 * seed-big-books.mjs — R-2566: staging-sized books in "E2E Test Co" on the LOCAL docker DB, to
 * measure (and guard) the speed of Invoices and Banking → Bank Reconciliation.
 *
 *   node scripts/dev/seed-big-books.mjs            (re)load: old PERF rows go, fresh rows come
 *   node scripts/dev/seed-big-books.mjs --clear    remove the PERF rows only
 *
 * What it makes (all tagged PERF, fixed ids, so a reload never duplicates):
 *   · bank account "PERF Big HDFC ··5173" (id below) with 5,173 lines: 3,500 imported and not
 *     reconciled ("In bank, not in books"), 1,400 imported and matched, 273 manual (in transit /
 *     not presented) — the shape of the 7 Nov staging import;
 *   · 20 customers "PERF Customer NN", 2,100 tax invoices INV-PERF-00001… and 2,000 receipts.
 *
 * Inserts AND the clear run with session_replication_role = replica (no triggers: pure test rows,
 * fast; an issued invoice could not be deleted otherwise) inside ONE transaction. Because nothing
 * cascades then, the clear removes the PERF rows' children itself: receipts, credit / debit notes
 * and every line on the PERF account. Rows the app made from PERF data in other tables (e.g. a
 * journal from reconciling a PERF line) are not tracked — use a fresh load for timing only. REFUSES (exit 1) unless the app reads the local docker DB — same guard as
 * scripts/dev/scenario.mjs (local-guard.mjs). Prints counts only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { scenarioTargetReason } from "./local-guard.mjs";
import { E2E_TENANT_EMAIL, E2E_TENANT_NAME } from "../../e2e/fixtures/e2e-roles.mjs";

export const PERF_ACCOUNT_ID = "c2566000-0000-4000-8000-000000000a01";
export const PERF_COUNTS = { lines: 5173, unbooked: 3500, matched: 1400, manual: 273, invoices: 2100, receipts: 2000 };

const here = dirname(fileURLToPath(import.meta.url));
const productionDir = resolve(here, "..", "..");
const die = (m) => { console.error(`seed-big-books: ${m}`); process.exit(1); };

function envLocal() {
  const f = join(productionDir, ".env.local");
  if (!existsSync(f)) return {};
  const out = {};
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const fileEnv = envLocal();
const URL_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
const container = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container, urls: URL_KEYS.flatMap((k) => [process.env[k], fileEnv[k]]) });
if (why) die(why);

function psql(sql) {
  const r = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) die(`psql failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const tenants = psql(`select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
if (tenants.length !== 1) die(`expected one "${E2E_TENANT_NAME}", found ${tenants.length}`);
const t = tenants[0].trim();
if (!/^[0-9a-f-]{36}$/i.test(t)) die("tenant id is not a uuid");

const clear = `
  delete from public.payments where tenant_id = '${t}' and reference like 'PERF-RCPT-%';
  -- children first (inserts and this clear run without triggers, so nothing cascades by itself)
  delete from public.credit_notes where tenant_id = '${t}' and invoice_id like 'INV-PERF-%';
  delete from public.debit_notes where tenant_id = '${t}' and invoice_id like 'INV-PERF-%';
  delete from public.payments where tenant_id = '${t}' and (invoice_id like 'INV-PERF-%' or id::text like 'c2566000-0000-4000-8000-4%');
  delete from public.invoices where tenant_id = '${t}' and id like 'INV-PERF-%';
  delete from public.customers where tenant_id = '${t}' and id::text like 'c2566000-0000-4000-8000-0000000c%';
  delete from public.bank_transactions where tenant_id = '${t}' and bank_account_id = '${PERF_ACCOUNT_ID}';
  delete from public.bank_accounts where tenant_id = '${t}' and id = '${PERF_ACCOUNT_ID}';
`;

const load = `
  insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, account_type, opening_balance, opening_balance_date, is_active, notes)
  values ('${PERF_ACCOUNT_ID}', '${t}', 'PERF Big HDFC', 'HDFC Bank', '5173', 'current', 2500000, current_date - 400, true,
          'R-2566 speed test (local only): scripts/dev/seed-big-books.mjs');

  -- 3,500 imported, not reconciled
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source)
  select ('c2566000-0000-4000-8000-1' || lpad(g::text, 11, '0'))::uuid, '${t}', '${PERF_ACCOUNT_ID}',
         current_date - 1 - (g % 360),
         case when g % 3 = 0 then 'NEFT DR-PERF VENDOR ' || (g % 97) else 'UPI/CR/' || (900000 + g) || '/PERF PAYER ' || (g % 53) end,
         case when g % 3 = 0 then 1000 + (g * 37) % 90000 else 0 end,
         case when g % 3 = 0 then 0 else 500 + (g * 53) % 120000 end,
         'PERF-U-' || g, case when g % 10 = 0 then 'api_fetch' else 'csv_upload' end
    from generate_series(1, ${PERF_COUNTS.unbooked}) g;

  -- 1,400 imported, matched to receipt g (same amount; matched_to_id = the payment's id, as the app stores it)
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source, matched_to_type, matched_to_id, matched_at)
  select ('c2566000-0000-4000-8000-2' || lpad(g::text, 11, '0'))::uuid, '${t}', '${PERF_ACCOUNT_ID}',
         current_date - (g % 380), 'NEFT CR-PERF CUSTOMER ' || ((g % 20) + 1), 0,
         case when g % 4 = 0 then (1180 + (g * 97) % 250000) / 2 else 1180 + (g * 97) % 250000 end,
         'PERF-M-' || g, 'csv_upload', 'payment', 'c2566000-0000-4000-8000-4' || lpad(g::text, 11, '0'), now()
    from generate_series(1, ${PERF_COUNTS.matched}) g;

  -- 273 manual lines (deposits in transit / payments not presented); a few before the opening date
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source)
  select ('c2566000-0000-4000-8000-3' || lpad(g::text, 11, '0'))::uuid, '${t}', '${PERF_ACCOUNT_ID}',
         case when g <= 3 then current_date - 410 else current_date - (g % 200) end,
         case when g % 2 = 0 then 'PERF cheque issued ' || g else 'PERF deposit ' || g end,
         case when g % 2 = 0 then 2000 + g * 11 else 0 end, case when g % 2 = 0 then 0 else 3000 + g * 13 end,
         'PERF-X-' || g, 'manual'
    from generate_series(1, ${PERF_COUNTS.manual}) g;

  insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, contact_email, notes)
  select ('c2566000-0000-4000-8000-0000000c' || lpad(g::text, 4, '0'))::uuid, '${t}', 'PERF Customer ' || lpad(g::text, 2, '0'),
         'Delhi', '07', 'India', 'unregistered_business', 'business', 'perf' || g || '@example.test', 'R-2566 speed test'
    from generate_series(1, 20) g;

  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                               taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items)
  select 'INV-PERF-' || lpad(g::text, 5, '0'), '${t}',
         ('c2566000-0000-4000-8000-0000000c' || lpad(((g % 20) + 1)::text, 4, '0'))::uuid, 'PERF Customer ' || lpad(((g % 20) + 1)::text, 2, '0'),
         amt, (case when g % 4 = 0 then 'pending' else 'paid' end)::invoice_status,
         current_date - (g % 380), current_date - (g % 380) + 15,
         round(amt / 1.18), amt - round(amt / 1.18), 18, false,
         case when g % 4 <> 0 then amt when g <= ${PERF_COUNTS.receipts} then amt / 2 else 0 end, 'tax_invoice',
         jsonb_build_array(jsonb_build_object('id', 'line-1', 'qty', 1, 'cost', 0, 'name', 'PERF service ' || g, 'rate', round(amt / 1.18)))
    from (select g, (1180 + (g * 97) % 250000)::int as amt from generate_series(1, ${PERF_COUNTS.invoices}) g) s;

  -- receipt g pays invoice g: in full for a paid invoice, half for a pending one (it shows as part-paid)
  insert into public.payments (id, tenant_id, invoice_id, customer_id, amount, method, status, received_at, reference)
  select ('c2566000-0000-4000-8000-4' || lpad(g::text, 11, '0'))::uuid, '${t}', 'INV-PERF-' || lpad(g::text, 5, '0'),
         ('c2566000-0000-4000-8000-0000000c' || lpad(((g % 20) + 1)::text, 4, '0'))::uuid,
         case when g % 4 = 0 then (1180 + (g * 97) % 250000) / 2 else 1180 + (g * 97) % 250000 end,
         'bank_transfer', 'received', now() - ((g % 380) || ' days')::interval, 'PERF-RCPT-' || g
    from generate_series(1, ${PERF_COUNTS.receipts}) g;
`;

const clearOnly = process.argv.includes("--clear");
const out = psql([
  "begin;", "set local session_replication_role = replica;", clear, clearOnly ? "" : load, "commit;",
  `select 'lines=' || count(*) from public.bank_transactions where bank_account_id = '${PERF_ACCOUNT_ID}';`,
  `select 'invoices=' || count(*) from public.invoices where tenant_id = '${t}' and id like 'INV-PERF-%';`,
  `select 'receipts=' || count(*) from public.payments where tenant_id = '${t}' and reference like 'PERF-RCPT-%';`,
].join("\n"));
console.log(`${E2E_TENANT_NAME} · local DB ${container} · ${clearOnly ? "cleared" : "loaded"}: ${out.join(" · ")}`);
