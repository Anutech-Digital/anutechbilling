/**
 * Card test — R-2545: Subscription "Correct details" is ONE save — a refused renewal date leaves
 * nothing changed (before: the payment frequency was already saved).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2545`.
 *
 * Data: this spec's OWN row in the LOCAL docker DB (E2E Test Co only): customer "CT R2545 Check Co"
 * with a yearly subscription "CT R2545 Workspace" — 12-month term, 29 Mar 2026 → 29 Mar 2027 (the
 * R800 shape from the card). Removed after the last step. Never runs against staging.
 * The SQL half (data fix / plan rolled back too, another company refused) is
 * supabase/tests/r2545_correct_details_one_save.sql.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PLAN = "CT R2545 Workspace";
const CUSTNAME = "CT R2545 Check Co";
const CUST = "c2545000-0000-4000-8000-000000000001";
const SUB = "c2545000-0000-4000-8000-000000000002";
const STEP_COUNT = 2;
const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2545-${process.ppid}.${what}`);

function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const name = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
  if (!name) throw new Error("R-2545 card test: no local supabase_db_* container — this test only runs on the local docker DB.");
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
delete from public.contract_amendments where subscription_id = '${SUB}';
delete from public.subscriptions where id = '${SUB}';
delete from public.customers where id = '${CUST}';
commit;`);
}
function loadRows(): void {
  clearRows();
  psql(`begin;
insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, notes)
values ('${CUST}', ${tenantSql}, '${CUSTNAME}', 'Delhi', '07', 'India', 'business', 'R-2545 card test (local only)');
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, status, domain)
values ('${SUB}', ${tenantSql}, '${CUST}', '${CUSTNAME}', '${PLAN}', 'google', 10, 1500, 'yearly', 12,
        '2026-03-29', '2027-03-29', 'active', 'ct-r2545.example');
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
const record = () => psql(`select billing_cycle || '|' || renewal_date from public.subscriptions where id = '${SUB}';`)[0];

/** Subscriptions → search → the row's ⋮ → Correct details. */
async function openCorrectDetails(page: Page) {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  await page.getByRole("searchbox", { name: /Search subscriptions/ }).or(page.getByLabel("Search subscriptions")).first().fill("CT R2545");
  const menu = page.getByRole("button", { name: new RegExp(`^Actions for ${PLAN} — `) }).filter({ visible: true });
  await expect(menu.first()).toBeVisible({ timeout: 60_000 });
  await menu.first().click();
  await page.getByRole("menuitem", { name: /Correct details/ }).click();
  const dlg = page.getByRole("dialog", { name: "Correct subscription" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  return dlg;
}

test.describe("R-2545 — Correct details saves everything or nothing", () => {
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

  test("Step 1: Yearly → Quarterly with renewal 31 Dec 2026 → refused 'too early', dialog stays open; reopened it is still Yearly, 29 Mar 2027", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    let dlg = await openCorrectDetails(page);
    await dlg.locator("#sub_frequency").selectOption("quarterly");
    await dlg.locator("#sub_renewal").fill("2026-12-31");
    await dlg.locator("#sub_correct_reason").fill("Customer pays quarterly");
    await dlg.getByRole("button", { name: /Save changes/ }).click();
    await expect(page.getByText(/too early/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(dlg).toBeVisible();                                          // stays open, entries kept
    await expect(dlg.locator("#sub_frequency")).toHaveValue("quarterly");
    expect(record()).toBe("yearly|2027-03-29");                               // nothing half-saved
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    dlg = await openCorrectDetails(page);
    await expect(dlg.locator("#sub_frequency")).toHaveValue("yearly");
    await expect(dlg.locator("#sub_renewal")).toHaveValue("2027-03-29");
    await page.context().close();
  });

  test("Step 2: Quarterly with renewal 28 Mar 2027 → 'Subscription corrected', both saved", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await openCorrectDetails(page);
    await dlg.locator("#sub_frequency").selectOption("quarterly");
    await dlg.locator("#sub_renewal").fill("2027-03-28");
    await dlg.locator("#sub_correct_reason").fill("Customer pays quarterly");
    await dlg.getByRole("button", { name: /Save changes/ }).click();
    await expect(page.getByText(/Subscription corrected/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(record()).toBe("quarterly|2027-03-28");
    await page.context().close();
  });
});
