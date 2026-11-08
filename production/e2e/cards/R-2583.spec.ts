/**
 * Card test — R-2583: a seat cut scheduled "At end of term" (R-2252) is billed at renewal.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2583`.
 *
 * Data: this spec's OWN rows in the LOCAL docker DB (E2E Test Co only): customer "SCN EOT Cut Co",
 * a yearly subscription "SCN EOT Cut Yearly" — 10 seats, mrr ₹1,500 (₹1,800 per seat a year),
 * renewing in 20 days — and a scheduled end-of-term cut 10 → 7 for that date (written straight into
 * subscription_seat_reductions: "At end of term" is still hidden in the dialog, R-2584). Removed
 * after the last step, with the renewal quote Step 1 makes. Never runs against staging.
 * The payment half (paying the quote → 7 seats, MRR for 7) is supabase/tests/r2583_renewal_seat_cut_payment.test.sql.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PLAN = "SCN EOT Cut Yearly";
const CUSTNAME = "SCN EOT Cut Co";
const CUST = "c2583000-0000-4000-8000-000000000001";
const SUB = "c2583000-0000-4000-8000-000000000002";
const CUT = "c2583000-0000-4000-8000-000000000003";
const STEP_COUNT = 2;
const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2583-${process.ppid}.${what}`);

function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const name = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
  if (!name) throw new Error("R-2583 card test: no local supabase_db_* container — this test only runs on the local docker DB.");
  return name;
}
function psql(sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}
const tenantSql = `(select id from public.tenants where email = '${E2E_TENANT_EMAIL}')`;

function clearRows(): void {
  psql(`begin;
set local session_replication_role = replica;
delete from public.subscription_seat_reductions where subscription_id = '${SUB}';
update public.subscriptions set renewal_quote_id = null where id = '${SUB}';
delete from public.quotes where customer_id = '${CUST}';
delete from public.subscriptions where id = '${SUB}';
delete from public.customers where id = '${CUST}';
commit;`);
}
function loadRows(): void {
  clearRows();
  psql(`begin;
insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, notes)
values ('${CUST}', ${tenantSql}, '${CUSTNAME}', 'Maharashtra', '27', 'India', 'business', 'R-2583 card test (local only)');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain, auto_renew)
values ('${SUB}', ${tenantSql}, '${CUST}', '${CUSTNAME}', '${PLAN}', 'google', 10, 1500, 'yearly', 12,
        (current_date + 20 - interval '12 months')::date, current_date + 20, 'active', 'scn-eotcut.example', true);
insert into public.subscription_seat_reductions (id, tenant_id, subscription_id, idempotency_key, timing, status,
                                                 seats_before, seats_removed, seats_after, effective_date, mrr_before)
values ('${CUT}', ${tenantSql}, '${SUB}', 'r2583-card-test-cut', 'end_of_term', 'scheduled', 10, 3, 7, current_date + 20, 1500);
commit;`);
}
function loadOncePerRun(): void {
  const marker = runMarker("loaded");
  if (fs.existsSync(marker)) return;
  loadRows();
  fs.writeFileSync(marker, new Date().toISOString());
}
function stepFinished(title: string): boolean {
  const file = runMarker("done");
  fs.appendFileSync(file, `${title}\n`);
  return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).size >= STEP_COUNT;
}

test.describe("R-2583 — a scheduled end-of-term seat cut is billed at renewal", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    if (CARD_TESTS_ON) loadOncePerRun();
  });
  let cleanUp = false;
  test.afterEach(({}, info) => {
    if (CARD_TESTS_ON && stepFinished(info.title)) cleanUp = true;
  });
  test.afterAll(() => {
    if (cleanUp) clearRows();
  });

  test("Step 1: Renewals → ⋯ → Create quote (don't send) → the quote is for 7 seats, ₹12,600 + GST = ₹14,868", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals", /Renewals/);
    const menu = page.getByRole("button", { name: `More renewal actions for ${CUSTNAME} — ${PLAN}` }).filter({ visible: true });
    await expect(menu.first()).toBeVisible({ timeout: 60_000 });
    await menu.first().click();
    await page.getByRole("menuitem", { name: /Create quote \(don.t send\)/ }).click();
    await expect(page).toHaveURL(/\/quotes\//, { timeout: 60_000 });
    await expect(page.getByText("₹14,868").first()).toBeVisible({ timeout: 60_000 });
    const [seats, amount, subtotal, qty] = psql(
      `select seats || '|' || amount || '|' || subtotal || '|' || (line_items->0->>'qty') from public.quotes where customer_id = '${CUST}';`,
    )[0].split("|");
    expect({ seats, amount, subtotal, qty }).toEqual({ seats: "7", amount: "14868", subtotal: "12600", qty: "7" });
    await page.context().close();
  });

  test("Step 2: Subscriptions → Manage seats → Reduce seats → Remove scheduled cut → refused, names the renewal quote", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/subscriptions", /^Subscriptions$/);
    const row = page.getByRole("button", { name: new RegExp(`^Open ${PLAN} for `) }).filter({ visible: true });
    await expect(row.first()).toBeVisible({ timeout: 60_000 });
    await row.first().click();
    await page.getByRole("button", { name: "Manage seats" }).first().click();
    const dlg = page.getByRole("dialog").filter({ hasText: CUSTNAME });
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole("button", { name: "Reduce seats" }).click();
    await expect(dlg.getByText(/A seat cut is already scheduled: 10 → 7 seats/)).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole("button", { name: "Remove scheduled cut" }).click();
    await expect(page.getByText(/Renewal quote .+ is already made for 7 seats with this cut/)).toBeVisible({ timeout: 30_000 });
    expect(psql(`select status from public.subscription_seat_reductions where id = '${CUT}';`)[0]).toBe("scheduled");
    await page.context().close();
  });
});
