/**
 * Card test — R-2252 (G-ZOHO Billing A17): Reduce seats in Manage seats, with the credit SHOWN
 * before saving (Zoho shows ₹0 and hides it).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2252`.
 *
 * Data: this spec's OWN rows, written straight into the LOCAL docker DB (supabase_db_* container,
 * E2E Test Co only — the same route scripts/dev/scenario.mjs uses; scenarios/index.mjs was locked
 * by another card when this was written): customer "SCN Seat Cut Co", a yearly Google Workspace
 * subscription "SCN Seat Cut Yearly" — 10 seats × ₹1,800/yr (mrr ₹1,500), term from the 1st two
 * months ago — its accepted quote and its PAID tax invoice (₹21,240). Removed after the last step
 * (with the credit note / customer credit / seat-cut row Step 4 makes). Never runs against staging.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PLAN = "SCN Seat Cut Yearly";
const CUST = "c2252000-0000-4000-8000-000000000001";
const SUB = "c2252000-0000-4000-8000-000000000002";
const QUOTE = "Q-SCN-SC-1";
const INV = "INV-SCN-SC-1";
const STEP_COUNT = 4;
const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2252-${process.ppid}.${what}`);

function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const name = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
  if (!name) throw new Error("R-2252 card test: no local supabase_db_* container — this test only runs on the local docker DB.");
  return name;
}
function psql(sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}
const tenantSql = `(select id from public.tenants where email = '${E2E_TENANT_EMAIL}')`;

/** Removes exactly this spec's rows (local DB, own ids). Triggers off: a credit note is never deleted from the app. */
function clearRows(): void {
  psql(`begin;
set local session_replication_role = replica;
delete from public.subscription_seat_reductions where subscription_id = '${SUB}';
delete from public.customer_credits where customer_id = '${CUST}';
delete from public.credit_notes where invoice_id = '${INV}';
delete from public.subscription_billings where subscription_id = '${SUB}';
delete from public.subscriptions where id = '${SUB}';
update public.quotes set invoice_id = null where id = '${QUOTE}';
delete from public.invoices where id = '${INV}';
delete from public.quotes where id = '${QUOTE}';
delete from public.customers where id = '${CUST}';
commit;`);
}

function loadRows(): void {
  clearRows();
  psql(`begin;
insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, notes)
values ('${CUST}', ${tenantSql}, 'SCN Seat Cut Co', 'Maharashtra', '27', 'India', 'business', 'R-2252 card test (local only)');
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, payment_status, created_date, billing_cycle, currency, line_items, notes)
values ('${QUOTE}', ${tenantSql}, '${CUST}', 'SCN Seat Cut Co', '${PLAN}', 10, 21240, 18000, 0, 18, 0,
        'accepted', 'paid', (date_trunc('month', current_date) - interval '2 months')::date, 'yearly', 'INR',
        '[{"id":"line-1","qty":10,"cost":0,"name":"${PLAN}","rate":1800,"commitment":"annual_yearly"}]'::jsonb, 'R-2252 card test');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, paid_date, document_kind, line_items, quote_id)
values ('${INV}', ${tenantSql}, '${CUST}', 'SCN Seat Cut Co', 21240, 21240, 'paid',
        (date_trunc('month', current_date) - interval '2 months')::date, (date_trunc('month', current_date) - interval '2 months')::date,
        18000, 3240, 18, true, 21240, (date_trunc('month', current_date) - interval '2 months')::date, 'tax_invoice',
        '[{"id":"line-1","qty":10,"cost":0,"name":"${PLAN}","rate":1800}]'::jsonb, '${QUOTE}');
update public.quotes set invoice_id = '${INV}' where id = '${QUOTE}';
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain, auto_renew, quote_id)
values ('${SUB}', ${tenantSql}, '${CUST}', 'SCN Seat Cut Co', '${PLAN}', 'google', 10, 1500, 'yearly', 12,
        (date_trunc('month', current_date) - interval '2 months')::date,
        (date_trunc('month', current_date) + interval '10 months')::date - 1, 'active', 'scn-seatcut.example', true, '${QUOTE}');
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

/** Subscriptions → open the row → Manage seats → Reduce seats → N seats. */
async function reduceSeats(page: Page, seats: number): Promise<Locator> {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  const row = page.getByRole("button", { name: new RegExp(`^Open ${PLAN} for `) }).filter({ visible: true });
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  await row.first().click();
  await page.getByRole("button", { name: "Manage seats" }).first().click();
  const dlg = page.getByRole("dialog").filter({ hasText: "SCN Seat Cut Co" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await dlg.getByRole("button", { name: "Reduce seats" }).click();
  await dlg.getByLabel("How many seats to remove?").fill(String(seats));
  return dlg;
}

test.describe("R-2252 — Reduce seats with a shown credit", () => {
  onlyInCardTests();

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

  test("Step 1: Manage seats → Reduce seats → 2 → the credit value (incl GST) and 'Credit to customer' show the same ₹ (invoice paid)", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await reduceSeats(page, 2);
    const value = dlg.getByTestId("reduce-seats-credit-value");
    await expect(value).toHaveText(/₹[\d,]+/, { timeout: 30_000 });
    const rupees = (await value.innerText()).replace(/[^\d]/g, "");
    await expect(dlg.getByTestId("reduce-seats-split")).toContainText(`Credit to customer (from money received): ₹${Number(rupees).toLocaleString("en-IN")}.00`);
    await expect(dlg.getByTestId("reduce-seats-split")).toContainText("Lowers what they still owe: ₹0.00");
    await expect(dlg.getByText(new RegExp(`One credit note on invoice ${INV}`))).toBeVisible();
    test.info().annotations.push({ type: "note", description: `Credit value ₹${rupees} for 2 of 10 seats` });
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    await page.context().close();
  });

  test("Step 2: 'At end of term' → 'Seats go from 10 to 8 on <renewal> … No credit', button 'Schedule for …'", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await reduceSeats(page, 2);
    await dlg.getByRole("button", { name: "At end of term" }).click();
    await expect(dlg.getByTestId("reduce-seats-eot")).toContainText(/Seats go from 10 to 8 on .+No credit/);
    await expect(dlg.getByRole("button", { name: /^Schedule for / })).toBeEnabled();
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    await page.context().close();
  });

  test("Step 3: 10 of 10 seats → 'At least 1 seat must stay', the button stays off", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await reduceSeats(page, 10);
    await expect(dlg.getByText(/At least 1 seat must stay/)).toBeVisible({ timeout: 30_000 });
    await expect(dlg.getByRole("button", { name: /^Remove 10 seats now$/ })).toBeDisabled();
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    await page.context().close();
  });

  test("Step 4: Remove 2 seats now → '2 seats removed — now 8 seats' with a credit note; the row shows 8 seats", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await reduceSeats(page, 2);
    await expect(dlg.getByTestId("reduce-seats-credit-value")).toHaveText(/₹[\d,]+/, { timeout: 30_000 });
    await dlg.getByRole("button", { name: /^Remove 2 seats now$/ }).click();
    await expect(page.getByText("2 seats removed — now 8 seats")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Credit note .+ for ₹/)).toBeVisible();
    const seats = psql(`select seats from public.subscriptions where id = '${SUB}';`)[0];
    expect(seats).toBe("8");
    await page.context().close();
  });
});
