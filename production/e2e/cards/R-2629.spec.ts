/**
 * Card test — R-2629: the Zoho FY purchase import keeps the Zoho bill's reference number in the
 * notes, so a bill that names its month lands in that month in the management P&L. The import needs
 * a Zoho Books scan (no Zoho on localhost), so the proof is supabase/tests/r2629_zoho_bill_reference.test.sql;
 * on localhost this only checks that COGS Bills still opens unchanged (the card changes no bill).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2629`.
 */
import { expect, test } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

test.describe("R-2629 — Zoho bill reference kept on import", () => {
  onlyInCardTests();

  test("Step 1: import keeps 'Ref: Google Portal Bill (Aug 2025)' → August", async () => {
    test.skip(true, "Needs a Zoho Books scan — proved by supabase/tests/r2629_zoho_bill_reference.test.sql (CI).");
  });

  test("Step 2: COGS Bills opens as before (no bill changed)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/bills");
    await expect(page.getByRole("button", { name: /add bill/i }).first()).toBeVisible();
    await page.close();
  });

  test("Step 3: staging Google bill moves to Aug after the repair", async () => {
    test.skip(true, "Staging data repair — only after Pardeep's OK (needsDecision).");
  });
});
