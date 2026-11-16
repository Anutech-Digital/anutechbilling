/**
 * Card test — R-2715 (Pratik audit 12 Nov, reports 5 + 6).
 *
 *  1. /customers/new: typing the full legal name "… India Private Limited" shows
 *     "Looks like <the existing "( INDIA) Pvt. Ltd" customer>" with an "Open it" link to it.
 *  2. /customers/new: the same GSTIN shows the hint under the GSTIN field (same GSTIN).
 *  3. Subscriptions → Add Subscription (Onboard dialog): the same name shows "Looks like …" and
 *     "Use it" picks that customer.
 *  4. Payment received with "Issue GST invoice now" unticked raises no invoice — needs a fresh
 *     onboarding quote + payment; proven by src/lib/payments/record-payment-invoice-r2715.test.ts
 *     (rule + wiring), so skipped here.
 *
 * Data: one planted customer in E2E Test Co (fixed id, local DB only, removed afterwards).
 * Run: `node scripts/ops/card-tests.mjs R-2715`.
 */
import { expect, test } from "@playwright/test";
import { E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated, fillKept } from "./card-steps";

const CUST_ID = "c2715000-0000-4000-8000-000000000001";
const STORED_NAME = "KESTREL MEDI ( INDIA) Pvt. Ltd";
const TYPED_NAME = "Kestrel Medi India Private Limited";
const GSTIN = "07AABCK2715A1Z5";

function seed(): void {
  localDb("R-2715").psql(`
    insert into public.customers (id, tenant_id, name, state, state_code, customer_type, gstin, contact_email, domain, notes)
    values ('${CUST_ID}', ${E2E_TENANT_SQL}, '${STORED_NAME}', 'Delhi', '07', 'business', '${GSTIN}',
            'accounts@kestrelmedi2715.example', 'kestrelmedi2715.example', 'Card test R-2715 — local only')
    on conflict (id) do nothing;`);
}
function clear(): void {
  localDb("R-2715").psql(`delete from public.customers where id = '${CUST_ID}' and tenant_id = ${E2E_TENANT_SQL};`);
}

test.describe("R-2715 — duplicate customer hint (Pvt Ltd = Private Limited, GSTIN) on both screens", () => {
  onlyInCardTests();
  test.setTimeout(240_000);
  test.beforeAll(() => seed());
  test.afterAll(() => clear());

  test("Step 1: /customers/new — the full legal name finds the existing short-form customer, Open it links to it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/customers/new");
      const name = page.locator("#name");
      await waitForHydrated(page, name);
      await fillKept(name, TYPED_NAME);
      const hint = await onlyOne(page.getByTestId("duplicate-customer-hint").filter({ hasText: STORED_NAME }), "the name hint");
      await expect(hint).toContainText("Looks like");
      await expect(hint).toContainText("same company name");
      const open = hint.getByRole("link", { name: `Open it: ${STORED_NAME}` });
      await expect(open).toHaveAttribute("href", `/customers/${CUST_ID}`);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: /customers/new — the same GSTIN shows the hint under GSTIN", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/customers/new");
      const gstin = page.locator("#gstin");
      await waitForHydrated(page, gstin);
      await fillKept(gstin, GSTIN.toLowerCase(), GSTIN);
      const hint = await onlyOne(page.getByTestId("duplicate-customer-hint").filter({ hasText: "same GSTIN" }), "the GSTIN hint");
      await expect(hint).toContainText(STORED_NAME);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Onboard dialog — the same name shows Looks like … and Use it picks the customer", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/subscriptions");
      const add = page.getByRole("button", { name: /^Add Subscription$/ });
      await expect(add).toBeVisible({ timeout: 60_000 });
      await add.click();
      const dlg = page.getByRole("dialog", { name: /Add \/ Onboard Subscription/ });
      const name = dlg.locator("#custName");
      await expect(name).toBeVisible({ timeout: 60_000 });
      await expect(async () => {
        await name.fill(TYPED_NAME);
        await expect(dlg.getByTestId("duplicate-customer-hint").filter({ hasText: STORED_NAME })).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      await dlg.getByRole("button", { name: `Use it: ${STORED_NAME}` }).click();
      await expect(name).toHaveValue(STORED_NAME);
      await expect(dlg.getByText("Clear Selection & Type Brand New Customer")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Payment received with 'Issue GST invoice now' unticked raises no invoice", async () => {
    test.skip(true, "Needs a fresh onboarding quote + payment; the rule and its wiring are proven by src/lib/payments/record-payment-invoice-r2715.test.ts");
  });
});
