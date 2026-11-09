/**
 * Card test — R-2637: a USD price is converted to ₹ without rounding each unit to whole rupees.
 * 10 × $2 @ ₹95.10 = ₹1,902 in the books (the old builder said 10 × ₹190 = ₹1,900).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2637`. Nothing is saved — the builder is left unsaved.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2637000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN USD Seats";

/** A customer abroad (United States, Overseas) — the builder shows USD billing only for an export customer. */
function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  /* "\\set" — a lone "\s" in a template literal is just "s", and psql would not stop on an error. */
  const sql = `
\\set ON_ERROR_STOP 1
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, 'United States', 'overseas', 'business', 'R-2637 card test: USD customer'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2637 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2637 — USD → ₹: the line total is converted, not a rounded unit", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Steps 1–2: USD @ 95.10, custom line 10 × $2 → books ₹190.20/unit and ₹1,902 line total", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/new?customer=${CUSTOMER_ID}`);
    /* An export customer defaults to USD and fetches today's rate — wait for it, then type ours. */
    await expect(page.locator("#billingCurrency")).toHaveValue("USD", { timeout: 60_000 });
    /* networkidle came BEFORE the auto-fetch started, so the fetched rate (e.g. 94.8755) landed after our
       95.10 and replaced it (10 Nov: dialog said ₹189.75/unit). Wait until the box leaves the "1" placeholder
       (fetch done); offline it stays 1 — then we just type after the wait. */
    await expect(page.locator("#billingRate")).not.toHaveValue("1", { timeout: 30_000 }).catch(() => {});
    await page.locator("#billingRate").fill("95.10");
    await expect(page.locator("#billingRate")).toHaveValue("95.1");

    await page.getByRole("button", { name: /Add item/ }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Custom item" }).click();
    await dialog.locator("#custom-name").fill("R-2637 seats");
    await dialog.locator("#custom-qty").fill("10");
    await dialog.locator("#custom-rate").fill("2");
    await dialog.locator("#custom-cost").fill("1.5");
    /* Step 1: the dialog says what the books record per unit — paise kept, not ₹190. */
    await expect(dialog).toContainText("recorded in books as ₹190.20/unit");
    await dialog.getByRole("button", { name: "Add line" }).click();
    await expect(dialog).toHaveCount(0);

    /* Step 2: the builder's books line — 10 × $2 × 95.10 = ₹1,902 (export, 0% GST); the old
       per-unit rounding said 10 × ₹190 = ₹1,900. */
    const books = page.getByText(/books record/).first();
    await expect(books).toBeVisible({ timeout: 30_000 });
    await expect(books).toContainText("books record ₹1,902");
    await expect(page.getByText(/\$20\.00/).first()).toBeVisible();
  });
});
