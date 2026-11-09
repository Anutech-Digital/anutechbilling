/**
 * Card test — R-2626: Change plan is refused while a LATER billing part already has a bill at the old
 * plan's rate (a proforma raised ahead / its invoice).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2626`.
 *
 * Data: scripts/dev/r2626-later-part.mjs (local docker DB only), loaded fresh once per run:
 * CT R2626 Parts Co, subscription "CT R2626 Monthly Starter", 10 seats, billed monthly; this month is
 * invoiced and paid, next month (Month 4) has proforma PI-CT2626-4 at the old rate. Removed after the
 * last step. The SQL half (record_payment refused under the row lock) is
 * supabase/tests/r2626_plan_change_vs_later_part.test.sql.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const STANDARD_ID = "E2E-GW-STD";
const R2626 = { plan: "CT R2626 Monthly Starter", proforma: "PI-CT2626-4" }; // scripts/dev/r2626-later-part.mjs

function loadR2626({ clear = false } = {}): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/r2626-later-part.mjs", ...(clear ? ["--clear"] : [])], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`r2626-later-part ${clear ? "--clear " : ""}failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}
const STEP_COUNT = 2;
const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2626-${process.ppid}.${what}`);

function loadOncePerRun(): void {
  const marker = runMarker("loaded");
  if (fs.existsSync(marker)) return;
  loadR2626();
  fs.writeFileSync(marker, new Date().toISOString());
}
function stepFinished(title: string): boolean {
  const file = runMarker("done");
  fs.appendFileSync(file, `${title}\n`);
  return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).size >= STEP_COUNT;
}

async function changePlan(page: Page): Promise<Locator> {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  const row = page.getByRole("button", { name: new RegExp(`^Open ${R2626.plan} for `) }).filter({ visible: true });
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  await row.first().click();
  const btn = page.getByRole("button", { name: "Change plan" }).first();
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  const dlg = page.getByRole("dialog").filter({ hasText: "Subscription · Change plan" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await dlg.getByLabel("New plan").selectOption(STANDARD_ID);
  await dlg.getByLabel("Seats").fill("10");
  return dlg;
}

test.describe("R-2626 — Change plan vs a later part already billed at the old rate", () => {
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
    if (cleanUp) loadR2626({ clear: true });
  });

  test("Step 1: Change plan → Business Standard, 10 seats → refused: next month's proforma PI-CT2626-4 is named with 'Cancel that proforma first'; no Create button", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await changePlan(page);
    const alert = dlg.getByRole("alert");
    /* The first preview (default plan) answers "costs less …" at once; the Business Standard preview can take
       over a minute on a cold `next dev` right after localhost:update — wait for the real refusal (9 Nov run). */
    await expect(alert).toContainText(/Month 4 \(.+ – .+\) already has proforma PI-CT2626-4 at the current plan's rate\./, { timeout: 150_000 });
    await expect(alert).toContainText("Cancel that proforma first (open it → Cancel proforma), then change the plan");
    await expect(dlg.getByRole("button", { name: "Create plan change quote" })).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: open PI-CT2626-4 → More → Cancel proforma (reason) → Change plan again → the calculation and Create plan change quote show", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${R2626.proforma}`);
    await page.getByRole("button", { name: "More" }).first().click();
    await page.getByRole("menuitem").filter({ hasText: "Cancel proforma" }).click();
    const cancel = page.getByRole("dialog").filter({ hasText: "Why is it cancelled?" });
    await expect(cancel).toBeVisible({ timeout: 30_000 });
    await cancel.getByLabel("Why is it cancelled?").fill("Plan changes first — bill next month again at the new rate");
    await cancel.getByRole("button", { name: "Cancel quote" }).click();
    await expect(cancel).toHaveCount(0, { timeout: 60_000 });
    await page.context().close();

    const again = await pageAs(browser, baseURL, "owner");
    const dlg = await changePlan(again);
    await expect(dlg.getByTestId("change-plan-calc")).toBeVisible({ timeout: 150_000 });
    await expect(dlg.getByRole("button", { name: "Create plan change quote" })).toBeVisible();
    await again.context().close();
  });
});
