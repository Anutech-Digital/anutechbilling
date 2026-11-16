/**
 * Card test — R-2859: a customer's subscriptions that Bill together suggests have ONE way to be billed.
 * Staging 16 Nov (Renewals → Overdue): the Bill together box offered one bill for a customer's two
 * subscriptions while each row ("Bills with …") still had its own "Bill next part" button.
 *  - Step 1: both rows say "Bills with …" and their ONE button is "Bill together"; "Bill next part" is only in ⋯.
 *  - Step 2: the row button opens the box's dialog with BOTH lines (closed with Cancel — no bill is made).
 *  - Step 3: untick one in the box → both rows are back on their own "Bill next part".
 * Run: `node scripts/ops/card-tests.mjs R-2859`.
 *
 * Data: the local scenario `bill-together-pair` (scripts/dev/scenario.mjs — local docker DB only), reloaded
 * fresh for the run and left in place so the owner can look at it (howToCheck). No proforma is made here.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const SCENARIO = "bill-together-pair";
const NAME = "SCN Pair Works";
const PLAN_A = "SCN Pair Standard";
const PLAN_B = "SCN Pair Starter";

/** Load this spec's own scenario — LOCAL docker DB only (scenario.mjs refuses anything else). */
function scenario(...flags: string[]): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...flags], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario ${SCENARIO} ${flags.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

const rowOf = (page: Page, plan: string) => page.locator("tr").filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) }).filter({ visible: true });

async function openOverdue(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  await expect(rowOf(page, PLAN_A)).toHaveCount(1, { timeout: 150_000 });
  /* the row buttons change once the Bill together check has answered — wait for the box to be usable */
  await expect(page.getByTestId("bill-together-group").filter({ hasText: NAME }).getByRole("button", { name: /Bill together/ })).toBeEnabled({ timeout: 150_000 });
}

test.describe("R-2859 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (CARD_TESTS_ON) scenario("--reset"); });

  test("Step 1: both rows say 'Bills with …' and their ONE button is Bill together; Bill next part is only in ⋯", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    for (const [plan, other] of [[PLAN_A, PLAN_B], [PLAN_B, PLAN_A]] as const) {
      const row = rowOf(page, plan);
      await expect(row.getByTestId("renewal-bills-with")).toHaveText(`Bills with ${other}`);
      const primary = await onlyOne(row.getByTestId("stage-primary"), `${plan} row button`);
      await expect(primary).toHaveText(/Bill together/, { timeout: 60_000 });
      await expect(row.getByRole("button", { name: /Bill next part/ })).toHaveCount(0);
    }
    /* one alone is still possible — in ⋯ */
    await rowOf(page, PLAN_A).getByTestId("stage-more").click();
    await expect(page.getByRole("menuitem", { name: /Bill next part/ })).toBeVisible();
    await page.keyboard.press("Escape");
    /* the Action column still fits 1280 / 1276 */
    for (const w of [1280, 1276]) {
      await page.setViewportSize({ width: w, height: 800 });
      const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(m.scroll, `no horizontal scroll at ${w}`).toBeLessThanOrEqual(m.inner);
    }
    await page.context().close();
  });

  test("Step 2: the row's Bill together opens ONE dialog with both subscriptions (Cancel — nothing is billed)", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    const primary = rowOf(page, PLAN_B).getByTestId("stage-primary");
    await expect(primary).toHaveText(/Bill together/, { timeout: 60_000 });
    await primary.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: /Bill together/ })).toBeVisible({ timeout: 60_000 });
    await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
    await expect(dlg.getByTestId("bill-together-lines")).toContainText(PLAN_A);
    await expect(dlg.getByTestId("bill-together-lines")).toContainText(PLAN_B);
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toHaveCount(0);
    await page.context().close();
  });

  test("Step 3: untick one in the Bill together box → both rows are back on their own Bill next part", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    const group = page.getByTestId("bill-together-group").filter({ hasText: NAME });
    await group.getByRole("checkbox", { name: new RegExp(PLAN_B) }).click();
    for (const plan of [PLAN_A, PLAN_B]) {
      await expect(rowOf(page, plan).getByTestId("stage-primary")).toHaveText(/Bill next part/);
    }
    /* tick it again → Bill together is back */
    await group.getByRole("checkbox", { name: new RegExp(PLAN_B) }).click();
    await expect(rowOf(page, PLAN_A).getByTestId("stage-primary")).toHaveText(/Bill together/);
    await page.context().close();
  });
});
