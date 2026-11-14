/**
 * Card test — R-2734: Onboard / Add Subscription → a domain plan gets "Register for N years".
 * Pratik (16 Oct): a client paid 3 years of domain registration and the dialog had no way past 1 year.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2734`. Nothing is saved — the dialog is CANCELLED.
 * What each payment path files (Postpaid / Payment Received / Opening) is proven by
 * add-subscription-years-r2734.test.tsx and supabase/tests/r2734_onboard_years.test.sql.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const ITEM_ID = "SCN-R2734-DOMAIN-IN";
const ITEM = "SCN R2734 Domain .in";

/** A Domain-vendor catalogue item priced per YEAR (R-526 unit_year): ₹800 list, ₹600 cost. */
function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type, is_active)
select '${ITEM_ID}', t.id, '${ITEM}', 'domain', 800, 600,
       '{"billing_unit":"unit_year"}'::jsonb, 'subscription', true
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2734 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** Remove the planted item again (every step Cancels, so nothing references it) — later card tests
 *  see the same E2E Test Co catalogue. */
function unplant(): void {
  const sql = `delete from public.items i using public.tenants t
 where i.id = '${ITEM_ID}' and i.tenant_id = t.id and t.email = '${E2E_TENANT_EMAIL}'
   and not exists (select 1 from public.subscriptions s where s.item_id = i.id);`;
  spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
}

test.describe("R-2734 — Add Subscription: domain 'Register for N years'", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) unplant();
  });

  test("Steps 1–2: domain plan at ₹800 a year, 3 years from 1 Apr 2025 → ₹2,400 once, renews 1 Apr 2028; Cancel saves nothing", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/subscriptions");
    const add = page.getByRole("button", { name: "Add Subscription", exact: true });
    await expect(add).toBeVisible({ timeout: 60_000 });
    await add.click();
    const dialog = page.getByRole("dialog", { name: /Add \/ Onboard Subscription/ });
    await expect(dialog).toBeVisible({ timeout: 60_000 });

    /* Step 1: Vendor Domain → the planted item; its price is the YEARLY ₹800 (not × 12). */
    await dialog.locator("#vendor").click();
    await page.getByRole("option", { name: /Domain/ }).first().click();
    await dialog.locator("#planSelect").click();
    await page.getByRole("option", { name: new RegExp(ITEM.replace(/[.]/g, "\\.")) }).click();
    await expect(dialog.locator("#pricePerSeat")).toHaveValue("800", { timeout: 30_000 });
    const years = dialog.getByLabel("Register for");
    await expect(years).toHaveValue("1");
    await dialog.locator("#seats").fill("1");

    /* Step 2: 3 years from 1 Apr 2025. */
    await dialog.locator("#startDate").fill("2025-04-01");
    await years.selectOption("3");
    await expect(dialog.locator("#renewalDate")).toHaveValue("2028-04-01");
    await expect(dialog.locator("#renewalDate")).toBeDisabled();
    await expect(dialog.getByTestId("reg-years-total")).toContainText("₹2,400 for 3 years, billed once");
    await expect(dialog.getByText("Total for 3 years, billed once:")).toBeVisible();

    /* Back to 1 year: the 1-year date, editable again. */
    await years.selectOption("1");
    await expect(dialog.locator("#renewalDate")).toHaveValue("2026-04-01");
    await expect(dialog.locator("#renewalDate")).toBeEnabled();

    /* Nothing is saved. */
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Step 3: a Workspace plan has no 'Register for'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/subscriptions");
    await page.getByRole("button", { name: "Add Subscription", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /Add \/ Onboard Subscription/ });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.locator("#vendor").click();
    await page.getByRole("option", { name: /Google/ }).first().click();
    await expect(dialog.getByLabel("Register for")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("Step 4: saving each payment path (Postpaid / Payment received / Opening)", async () => {
    test.skip(true, "Writes a subscription / quote — kept out of the card test. Each path's rows are proven by add-subscription-years-r2734.test.tsx (dialog writes) and supabase/tests/r2734_onboard_years.test.sql (record_payment + trigger on the local DB).");
  });
});
