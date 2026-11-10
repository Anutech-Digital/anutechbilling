#!/usr/bin/env node
/**
 * R-2622 — LOCAL data for the P&L "Management (matched)" check.
 *
 *   node scripts/dev/r2622-pnl-matched.mjs           add (or re-add) the bill
 *   node scripts/dev/r2622-pnl-matched.mjs --clear   remove it again
 *
 * Adds to E2E Test Co (local docker DB only — refused anywhere else) one Google Workspace COGS bill
 * dated 7 Oct 2026, bill no R2622-GOOGLE, notes "Google Portal Bill (Aug 2026)", ₹50,000 + IGST
 * ₹9,000 — the owner's real case (Google bills a month or two after the licence month).
 *   As invoiced (GST): October cost of goods includes it.
 *   Management (matched): August includes it ("read from the bill text"); October does not.
 * Idempotent: the bill is matched by its bill no and replaced on every run.
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

const del = `delete from public.vendor_bills where tenant_id = '${tenant}' and (bill_no = 'R2622-GOOGLE' or id = 'BILL-R2622-GOOGLE');`;
const add = `insert into public.vendor_bills
  (id, tenant_id, vendor_name, vendor_gstin, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total, status, notes, document_type)
values ('BILL-R2622-GOOGLE', '${tenant}', 'Google Cloud India Pvt Ltd', '29AACCG0527D1Z8', 'R2622-GOOGLE', date '2026-10-07', 'COGS-Workspace',
        50000, 0, 0, 9000, 59000, 'unpaid', 'Google Portal Bill (Aug 2026)', 'tax_invoice');`;
const out = psql(`begin;\n${del}\n${clear ? "" : add}\ncommit;\nselect count(*) from public.vendor_bills where tenant_id = '${tenant}' and bill_no = 'R2622-GOOGLE';`);
console.log(clear
  ? `✓ R-2622 bill removed (${out.at(-1)} left).`
  : `✓ R-2622: Google bill R2622-GOOGLE dated 7 Oct 2026 "Google Portal Bill (Aug 2026)" ₹50,000 + IGST ₹9,000 in ${E2E_TENANT_NAME}.
  Accounting → P&L: Management (matched) → August has it ("read from the bill text"); October does not.
  As invoiced (GST) → October has it.`);
