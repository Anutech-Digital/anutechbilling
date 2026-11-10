/**
 * Card test — R-2648 (R-2636 follow-up, money-rules G16): a NEW quote for a customer abroad starts at
 * 0% GST when the company holds an LUT for today's FY (export without payment); no LUT → the old rate
 * + an Add-LUT warning (the no-LUT case is proven by unit tests — the local company keeps its LUT).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2648`.
 *
 * Data: planted by this spec on the LOCAL docker DB — customer "SCN Abroad R2648" (United States,
 * Overseas), no quotes. Fixed id, re-planted on each run. The LUT for FY 2026-27 comes from scenario
 * lut-per-fy (already on E2E Test Co). The test never saves — Cancel / Escape only.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2648000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Abroad R2648";

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'United States', 'overseas', 'business', 'R-2648 card test: customer abroad'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2648 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2648 — new quotes for a customer abroad start at 0% under the FY's LUT", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: Project Sales → New quotation → customer abroad → GST rate 0, IGST ticked, LUT named", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/projects");
    await page.getByRole("button", { name: "New quotation" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.locator("#q_customer").selectOption({ label: CUSTOMER });
    await expect(sheet.locator("#q_gst")).toHaveValue("0", { timeout: 60_000 });
    await expect(sheet.getByLabel(/Inter-state \(IGST\)/)).toBeChecked();
    await expect(sheet.getByTestId("export-lut-note")).toContainText(/0% GST under LUT \S+ \(FY 2026-27\)/);
    await expect(sheet).toContainText("GST @ 0%");
  });

  test("Step 2: Project Sales → New project → same customer → GST rate 0 under the LUT", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/projects");
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.locator("#p_customer").click();
    await page.getByLabel("Search customers", { exact: true }).fill(CUSTOMER);
    await page.getByRole("button", { name: new RegExp(`^${CUSTOMER}`) }).first().click();
    await expect(sheet.locator("#p_gst")).toHaveValue("0", { timeout: 60_000 });
    await expect(sheet.getByTestId("export-lut-note")).toContainText("0% GST under LUT");
  });

  test("Step 3: no LUT for the FY → 18% + Add LUT warning", async () => {
    test.skip(true, "the local company keeps its LUT (deleting it would change other cards' data) — proven by unit tests export-quote-rate / project-dialog-export-rate-r2648 / extend-subscription-dialog");
  });
});
