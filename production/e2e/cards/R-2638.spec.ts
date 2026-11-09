/**
 * Card test — R-2638: a USD quote's discount / approval compares the USD price with the item's USD
 * list, never with the ₹ catalogue. Reproduced bug: Commitment Annual → Monthly on a catalogue line
 * put the ₹ monthly tier on the USD line ($11.57 instead of $4), and typing $4 back showed
 * "Quote discount (65%)" — the false approval of the Sep reconcile.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2638`. Nothing is saved — the builder is left unsaved.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2638000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN USD Export";
const ITEM_ID = "SCN-R2638-USD-SEAT";
const ITEM = "SCN USD Cloud Seat";

/** A customer abroad + a catalogue item: ₹1,000/seat/month (₹1,100 flex), USD $4/seat/month. */
function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'United States', 'overseas', 'business', 'R-2638 card test: USD customer'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type, is_active)
select '${ITEM_ID}', t.id, '${ITEM}', 'other', 1000, 700,
       '{"annual":{"msrp":1000,"wholesale":700},"monthly":{"msrp":1100,"wholesale":770},"usd":{"msrp":4,"wholesale":2.5}}'::jsonb,
       'subscription', true
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2638 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2638 — USD quote: no false discount against the ₹ catalogue", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Steps 1–3: add the USD item, switch to Monthly, type $4 → no Quote discount; $2.80 → 30%", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/new?customer=${CUSTOMER_ID}`);
    await expect(page.locator("#billingCurrency")).toHaveValue("USD", { timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.locator("#billingRate").fill("95.10");
    await expect(page.locator("#billingRate")).toHaveValue("95.1");

    /* Step 1: add the catalogue item — it comes in at its USD price, no discount. */
    await page.getByRole("button", { name: /Add item/ }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Search items by name or SKU…").fill(ITEM);
    await dialog.getByRole("button", { name: new RegExp(ITEM) }).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Quote discount")).toHaveCount(0);

    /* Step 2: Commitment → Flexible (monthly): the rate stays the USD $4, not the ₹ tier ($11.57). */
    const commit = page.getByLabel(`Commitment for ${ITEM}`);
    await commit.selectOption("monthly");
    const rate = page.getByLabel(`Rate for ${ITEM}`);
    await expect(rate).toHaveValue("4");
    await rate.fill("4");
    await expect(page.getByText("Quote discount")).toHaveCount(0);

    /* Step 3: a real USD discount still counts — $2.80 on the $4 list is 30%. */
    await rate.fill("2.8");
    await expect(page.getByText("Quote discount (30%)")).toBeVisible();
  });
});
