#!/usr/bin/env node
/**
 * seed-e2e-approval.mjs — the R-2213 "another owner approves" scenario in "E2E Test Co",
 * LOCAL DB only (R-2318).
 *
 *   node scripts/dev/seed-e2e-approval.mjs          (from production/, local stack running)
 *
 * R-2213: a Manage-seats quote priced below cost needs another owner's approval before
 * Reconcile may save money against it. Checking that on localhost needs (a) two owners — the
 * "Owner 2" test login, seeded by e2e/fixtures/seed-e2e-tenant.mjs when E2E_OWNER2_PASSWORD is
 * set — and (b) a subscription whose seats cost more than they sell for. This adds (b):
 *
 *   - catalogue item  "E2E R2213 Yearly Seat" (id E2E-R2213-YEARLY, google): sells ₹1,200/seat/year
 *     (₹100/seat/month) and COSTS ₹1,500/seat/year (₹125/seat/month) — every seat added is below cost;
 *   - customer        "R2213 Approval Test" (Maharashtra, same state as the company);
 *   - subscription    yearly, active, 2 seats on that item (₹200/month), started 60 days ago,
 *                     renews in ~10 months — so Manage seats makes a pro-rata quote;
 *   - bank line       a ₹2,000 money-in line on "E2E Bank Current A/c" from R2213 APPROVAL TEST,
 *                     to reconcile against that quote.
 *
 * Prices are whole rupees per seat per year so that MRR (an integer column) is exact:
 * annual per seat = mrr × 12 ÷ seats = 200 × 12 ÷ 2 = ₹1,200.
 *
 * Idempotent: rows are found again by fixed id (item, subscription, bank line) or by name
 * (customer); existing rows are left exactly as they are (dates, seats a tester added) and
 * nothing is ever deleted. A re-run prints "0 added".
 *
 * REFUSES (exit 1) when the Supabase URL is not local (hard-coded, no override), when
 * "E2E Test Co" or its bank account does not exist yet (run
 * E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs first), or when a fixed id already
 * belongs to another company. Prints names and counts only — never a key.
 */
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { localSupabase } from "./local-guard.mjs";
import { E2E_TENANT_EMAIL, E2E_TENANT_NAME, E2E_BANK_NAME } from "../../e2e/fixtures/e2e-roles.mjs";

const R2213_CUSTOMER_NAME = "R2213 Approval Test";
const R2213_ITEM = {
  id: "E2E-R2213-YEARLY",
  vendor: "google",
  name: "E2E R2213 Yearly Seat",
  msrp: 100, // ₹/seat/month = ₹1,200/seat/year
  wholesale: 125, // ₹/seat/month = ₹1,500/seat/year — above the price on purpose
};
const R2213_SUB_ID = "c2318000-0000-4000-8000-000000000001";
const R2213_TXN_ID = "c2318000-0000-4000-8000-000000000002";
const SEATS = 2;

function die(msg) {
  console.error(`seed-e2e-approval: ${msg}`);
  process.exit(1);
}

/** yyyy-mm-dd, `days` from today (UTC calendar date). */
function dayOffset(days, base = new Date()) {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}
/** Last covered day of a one-year term from `start` (inclusive, R-801). */
function yearEndInclusive(start) {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d - 1)).toISOString().slice(0, 10);
}

const productionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sb = localSupabase(productionDir);
if ("reason" in sb) die(sb.reason);
const admin = createClient(sb.url, sb.service, { auth: { autoRefreshToken: false, persistSession: false } });

/** Find a row by id; refuse when it belongs to another company. Returns true when it exists. */
async function existsById(table, id, tenantId) {
  const { data, error } = await admin.from(table).select("id, tenant_id").eq("id", id).maybeSingle();
  if (error) throw new Error(`${table} select: ${error.message}`);
  if (data && data.tenant_id !== tenantId) die(`${table} ${id} exists in another company — not touching it.`);
  return !!data;
}

async function insert(table, row) {
  const { error } = await admin.from(table).insert(row);
  if (error) throw new Error(`${table} insert: ${error.message}`);
}

try {
  const { data: tenants, error: tErr } = await admin.from("tenants").select("id").eq("email", E2E_TENANT_EMAIL);
  if (tErr) throw new Error(`tenants select: ${tErr.message}`);
  if (!tenants?.length) die(`"${E2E_TENANT_NAME}" not found — run E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs first.`);
  if (tenants.length > 1) die(`${tenants.length} tenants carry ${E2E_TENANT_EMAIL}; fix by hand first.`);
  const tenantId = tenants[0].id;

  const { data: banks, error: bErr } = await admin.from("bank_accounts").select("id")
    .eq("tenant_id", tenantId).eq("name", E2E_BANK_NAME);
  if (bErr) throw new Error(`bank_accounts select: ${bErr.message}`);
  if (!banks?.length) die(`"${E2E_BANK_NAME}" not found — run the E2E tenant seed first.`);
  const bankId = banks[0].id;

  const added = [];

  if (!(await existsById("items", R2213_ITEM.id, tenantId))) {
    await insert("items", {
      ...R2213_ITEM, tenant_id: tenantId, kind: "main", item_type: "subscription", is_active: true, term_months: 12,
      prices: { annual: { msrp: R2213_ITEM.msrp, wholesale: R2213_ITEM.wholesale }, billing_unit: "seat_month" },
    });
    added.push("product");
  }

  const { data: custRows, error: cErr } = await admin.from("customers").select("id")
    .eq("tenant_id", tenantId).eq("name", R2213_CUSTOMER_NAME);
  if (cErr) throw new Error(`customers select: ${cErr.message}`);
  let customerId = custRows?.[0]?.id;
  if (!customerId) {
    const { data, error } = await admin.from("customers").insert({
      tenant_id: tenantId,
      name: R2213_CUSTOMER_NAME,
      state: "Maharashtra",
      state_code: "27",
      country: "India",
      customer_type: "business",
      contact_name: "R2213 Contact",
      contact_email: "r2213-approval@example.test",
    }).select("id").single();
    if (error) throw new Error(`customers insert: ${error.message}`);
    customerId = data.id;
    added.push("customer");
  }

  if (!(await existsById("subscriptions", R2213_SUB_ID, tenantId))) {
    const start = dayOffset(-60);
    await insert("subscriptions", {
      id: R2213_SUB_ID,
      tenant_id: tenantId,
      customer_id: customerId,
      customer_name: R2213_CUSTOMER_NAME,
      domain: "r2213-approval.example",
      plan: R2213_ITEM.name,
      vendor: R2213_ITEM.vendor,
      item_id: R2213_ITEM.id,
      seats: SEATS,
      mrr: R2213_ITEM.msrp * SEATS,
      vendor_cost_per_seat_month: R2213_ITEM.wholesale,
      start_date: start,
      renewal_date: yearEndInclusive(start),
      status: "active",
      billing_cycle: "yearly",
      term_months: 12,
    });
    added.push("subscription");
  }

  if (!(await existsById("bank_transactions", R2213_TXN_ID, tenantId))) {
    await insert("bank_transactions", {
      id: R2213_TXN_ID,
      tenant_id: tenantId,
      bank_account_id: bankId,
      txn_date: dayOffset(-1),
      description: "NEFT CR-HDFC0009999-R2213 APPROVAL TEST-SEATS R2318",
      debit: 0,
      credit: 2000,
      reference: "R2318-N2213",
      source: "csv_upload",
    });
    added.push("bank line");
  }

  console.log(`"${E2E_TENANT_NAME}": R-2213 approval scenario — ${added.length} added${added.length ? ` (${added.join(", ")})` : ""}, `
    + `${4 - added.length} already there.`);
  console.log(`  customer "${R2213_CUSTOMER_NAME}" · ${SEATS} seats of "${R2213_ITEM.name}" at ₹1,200/seat/year (cost ₹1,500) · ₹2,000 money-in line on "${E2E_BANK_NAME}"`);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
