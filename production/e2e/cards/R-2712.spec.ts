/**
 * Card test — R-2712: quote "Bulk / many domains" gets "Register for N years" (domain plans) and a
 * Start date. Pratik (16 Oct): a client paid 3 years of domain registration and the Bulk dialog
 * could only make a 1-year line starting today.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2712`. Nothing is saved — the builder is left unsaved.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2712000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Bulk Domains";
const ITEM_ID = "SCN-R2712-DOMAIN-IN";
const ITEM = "SCN R2712 Domain .in";

/** A customer + a Domain-vendor catalogue item priced per YEAR: ₹800 list, ₹600 cost. */
function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
insert into public.customers (id, tenant_id, name, state, state_code, country, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', 'Delhi', '07', 'India', 'business', 'R-2712 card test: bulk domains'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type, is_active)
select '${ITEM_ID}', t.id, '${ITEM}', 'domain', 800, 600,
       '{"billing_unit":"unit_year"}'::jsonb, 'subscription', true
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2712 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2712 — Bulk / many domains: Register for N years + Start date", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Steps 1–2: Bulk dialog — 2 domains, ₹800 a year, 3 years from 1 Sep 2026 → one line of ₹4,800, years and start on the line", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/new?customer=${CUSTOMER_ID}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    /* Step 1: the dialog asks the start date and, for a domain plan, the years. */
    const bulkButton = page.getByRole("button", { name: "Bulk / many domains" }).first();
    await expect(bulkButton).toBeVisible({ timeout: 60_000 });
    await bulkButton.click();
    const dialog = page.getByRole("dialog", { name: /Bulk order — many domains/ });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByLabel("Register for")).toHaveCount(0);   // no plan yet → no years picker
    await dialog.getByLabel("Plan").selectOption({ label: ITEM });
    await expect(dialog.getByLabel("Register for")).toHaveValue("1");
    await expect(dialog.getByLabel("Rate (₹/seat/year)")).toHaveValue("800");   // per-year item: not × 12
    await dialog.getByLabel("Start date").fill("2026-09-01");
    await dialog.getByLabel("Register for").selectOption("3");
    await dialog.getByLabel("Domain 1").fill("r2712-a.in");
    await dialog.getByRole("button", { name: "Add domain" }).click();
    await dialog.getByLabel("Domain 2").fill("r2712-b.in");

    const summary = dialog.getByTestId("bulk-summary");
    await expect(summary).toContainText("₹4,800");
    await expect(summary).toContainText("for 3 years, billed once (ex-GST)");
    await expect(summary).toContainText("Each subscription starts 1 Sep 2026 and renews 1 Sep 2029.");

    /* Step 2: the line carries the 3 years and the start date; its rate is the whole term. */
    await dialog.getByRole("button", { name: "Add bulk line (2)" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel(`Registration years for ${ITEM}`)).toHaveValue("3");
    await expect(page.getByLabel(`Start date for ${ITEM}`)).toHaveValue("2026-09-01");
    await expect(page.getByLabel(`Rate for ${ITEM}`)).toHaveValue("2400");

    /* Years changed on the line: 3 → 2 rescales the rate (2 × ₹800). */
    await page.getByLabel(`Registration years for ${ITEM}`).selectOption("2");
    await expect(page.getByLabel(`Rate for ${ITEM}`)).toHaveValue("1600");
  });

  test("Step 3: after payment — one subscription per domain, start 1 Sep 2026, renewal 1 Sep 2029", async () => {
    test.skip(true, "Needs the quote saved and paid (Record payment) and migration 20261113004902 on the local DB; the filing itself is proven by supabase/tests/r2712_bulk_years.test.sql (A).");
  });
});
