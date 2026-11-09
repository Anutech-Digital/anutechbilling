/**
 * Card test — R-2537 "Customer edit: saving never changes the GST treatment by itself".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2537`.
 *
 * Data: the local scenario `usd-inw-lines` (scripts/dev/scenario.mjs — local docker DB only) is
 * loaded once before the steps: SCN Design Box LLC, United States, Overseas. The steps only open the
 * edit page and change fields on screen — nothing is saved, so the customer stays as it is.
 * The "no country stored" case (D N B DESIGNS on staging) has no local data; it is covered by
 * src/components/features/customers/customer-edit-treatment-r2537.test.tsx.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUSTOMER_ID = "c2458000-0000-4000-8000-000000000011"; // SCN Design Box LLC (usd-inw-lines.sql)

function loadScenario(): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "usd-inw-lines"], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario usd-inw-lines failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

async function openEdit(page: Page): Promise<void> {
  await openAppPage(page, `/customers/${CUSTOMER_ID}/edit`);
  await expect(page.locator("#gst_treatment")).toHaveValue("overseas", { timeout: 60_000 });
}

async function pickCountry(page: Page, name: string): Promise<void> {
  await page.locator("#country").click();
  await page.getByRole("searchbox", { name: "Search countries" }).fill(name);
  await page.getByRole("option", { name, exact: true }).click();
}

test.describe("R-2537 card test", () => {
  onlyInCardTests();
  test.beforeAll(() => { if (CARD_TESTS_ON) loadScenario(); });

  test("Step 1: Edit SCN Design Box LLC — opens as United States / Overseas, no change notice", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openEdit(page);
    await expect(page.locator("#country")).toHaveText(/United States/);
    await expect(page.getByText(/GST treatment changes from/)).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: region → India shows 'GST treatment changes from Overseas to Unregistered Business'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openEdit(page);
    await pickCountry(page, "India");
    await expect(page.locator("#gst_treatment")).toHaveValue("unregistered_business");
    await expect(page.getByText(/GST treatment changes from Overseas to Unregistered Business/)).toBeVisible();
    await page.context().close();
  });

  test("Step 3: region back to United States → Overseas again, the note is gone (nothing saved)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openEdit(page);
    await pickCountry(page, "India");
    await expect(page.locator("#gst_treatment")).toHaveValue("unregistered_business");
    await pickCountry(page, "United States");
    await expect(page.locator("#gst_treatment")).toHaveValue("overseas");
    await expect(page.getByText(/GST treatment changes from/)).toHaveCount(0);
    await page.context().close();
  });
});
