#!/usr/bin/env node
/**
 * R-2624 — LOCAL data for the P&L "Management (matched)" revenue check.
 *
 *   node scripts/dev/r2624-revenue-matched.mjs           add (or re-add) the invoice
 *   node scripts/dev/r2624-revenue-matched.mjs --clear   remove it again
 *
 * Adds to E2E Test Co (local docker DB only — refused anywhere else) one yearly prepaid invoice
 * R2624-YEARLY dated 1 Oct 2026: Google Workspace Business Starter, annual commitment, ₹12,000 +
 * GST ₹2,160 — the owner's case (a whole year billed in October).
 *   As invoiced (GST): October revenue includes ₹12,000.
 *   Management (matched): ₹1,000 in each month Oct 2026..Sep 2027 ("for Oct 2026 – Sep 2027").
 * Re-runnable: an identical row is reused; a changed one (or --clear) is removed locally (see below).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { scenarioTargetReason } from "./local-guard.mjs";
import { E2E_TENANT_EMAIL, E2E_TENANT_NAME } from "../../e2e/fixtures/e2e-roles.mjs";

const productionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const clear = process.argv.includes("--clear");

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
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) die(`psql failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const tenants = psql(`select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
if (tenants.length !== 1) die(`expected one "${E2E_TENANT_NAME}", found ${tenants.length} — run E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs first.`);
const tenant = tenants[0].trim();
if (!/^[0-9a-f-]{36}$/i.test(tenant)) die("tenant id is not a uuid");

/* Re-runnable (coordinator 9 Nov: the second run hit "Invoice R2624-YEARLY is pending and cannot be
   deleted … raise a credit note"). An issued invoice is protected by the delete guard on purpose, so:
   - a row that is already exactly the fixture is REUSED (nothing written — the usual re-run);
   - a changed row, or --clear, is removed with the invoices table's user triggers off inside this
     one transaction and on again before commit — the scenario scripts' local-only pattern
     (scripts/dev/scenarios/_common.sql, r2626-later-part.mjs); the guard itself is untouched and
     this file refuses anything but the local docker DB (scenarioTargetReason above). */
const LINES = '[{"id":"l1","name":"Google Workspace Business Starter (12 months)","qty":1,"rate":12000,"commitment":"annual_yearly"}]';
const same = psql(`select count(*) from public.invoices
  where tenant_id = '${tenant}' and id = 'R2624-YEARLY' and taxable_value = 12000 and tax_amount = 2160 and amount = 14160
    and invoice_date = date '2026-10-01' and status in ('pending', 'paid', 'overdue') and document_kind = 'tax_invoice'
    and line_items = '${LINES}'::jsonb;`);
if (!clear && same.at(-1) === "1") {
  console.log(`✓ R-2624: yearly invoice R2624-YEARLY (1 Oct 2026, ₹12,000 + GST ₹2,160) already in ${E2E_TENANT_NAME} — reused.`);
  process.exit(0);
}
const del = `alter table public.invoices disable trigger user;
delete from public.invoices where tenant_id = '${tenant}' and id = 'R2624-YEARLY';
alter table public.invoices enable trigger user;`;
const add = `insert into public.invoices
  (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, due_date, document_kind, line_items)
values ('R2624-YEARLY', '${tenant}', 'R2624 Yearly Customer', 14160, 12000, 2160, 18, 'pending', date '2026-10-01', date '2026-10-31', 'tax_invoice',
        '${LINES}'::jsonb);`;
const out = psql(`begin;\n${del}\n${clear ? "" : add}\ncommit;\nselect count(*) from public.invoices where tenant_id = '${tenant}' and id = 'R2624-YEARLY';`);
console.log(clear
  ? `✓ R-2624 invoice removed (${out.at(-1)} left).`
  : `✓ R-2624: yearly invoice R2624-YEARLY dated 1 Oct 2026, ₹12,000 + GST ₹2,160 in ${E2E_TENANT_NAME}.
  Accounting → P&L, Oct 2026: Management (matched) → Revenue drill shows it at ₹1,000 "for Oct 2026 – Sep 2027";
  As invoiced (GST) → ₹12,000.`);
