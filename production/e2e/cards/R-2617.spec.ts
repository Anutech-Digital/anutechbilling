/**
 * Card test — R-2617: Change plan is refused while a seat cut is scheduled "At end of term".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2617`.
 *
 * Data: the `plan-change` scenario (scripts/dev/scenario.mjs — local docker DB only, the same one
 * R-2227's card test uses), loaded fresh once per run: SCN Plan Change Co, subscription
 * "SCN Plan Change Starter", 10 seats, paid yearly. Step 1 schedules an end-of-term cut 10 → 8
 * through Manage seats; after the last step `scenario.mjs plan-change --clear` removes it all.
 * The SQL half (record_payment / Correct details refused under the row lock) is
 * supabase/tests/r2617_plan_change_vs_seat_cut.test.sql.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const SCENARIO = "plan-change";
const PLAN = "SCN Plan Change Starter";
const CUSTNAME = "SCN Plan Change Co";
const STANDARD_ID = "E2E-GW-STD";
const STEP_COUNT = 3;
const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2617-${process.ppid}.${what}`);

function scenario(...flags: string[]): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...flags], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario ${SCENARIO} ${flags.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}
function loadScenarioOncePerRun(): void {
  const marker = runMarker("loaded");
  if (fs.existsSync(marker)) return;
  scenario("--reset");
  fs.writeFileSync(marker, new Date().toISOString());
}
function stepFinished(title: string): boolean {
  const file = runMarker("done");
  fs.appendFileSync(file, `${title}\n`);
  return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).size >= STEP_COUNT;
}

async function openSub(page: Page): Promise<void> {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  const row = page.getByRole("button", { name: new RegExp(`^Open ${PLAN} for `) }).filter({ visible: true });
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  await row.first().click();
}

async function reduceSeats(page: Page): Promise<Locator> {
  await openSub(page);
  await page.getByRole("button", { name: "Manage seats" }).first().click();
  const dlg = page.getByRole("dialog").filter({ hasText: CUSTNAME });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await dlg.getByRole("button", { name: "Reduce seats" }).click();
  return dlg;
}

async function changePlan(page: Page): Promise<Locator> {
  await openSub(page);
  const btn = page.getByRole("button", { name: "Change plan" }).first();
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  const dlg = page.getByRole("dialog").filter({ hasText: "Subscription · Change plan" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await dlg.getByLabel("New plan").selectOption(STANDARD_ID);
  await dlg.getByLabel("Seats").fill("10");
  return dlg;
}

test.describe("R-2617 — Change plan vs a scheduled end-of-term seat cut", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    if (CARD_TESTS_ON) loadScenarioOncePerRun();
  });
  let cleanUp = false;
  test.afterEach(({}, info) => {
    if (CARD_TESTS_ON && stepFinished(info.title)) cleanUp = true;
  });
  test.afterAll(() => {
    if (cleanUp) scenario("--clear");
  });

  test("Step 1: Manage seats → Reduce seats → 2 seats, At end of term → Schedule → cut 10 → 8 shows as scheduled", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await reduceSeats(page);
    await dlg.getByLabel("How many seats to remove?").fill("2");
    await dlg.getByRole("button", { name: "At end of term" }).click();
    await expect(dlg.getByTestId("reduce-seats-eot")).toBeVisible({ timeout: 30_000 });
    await dlg.getByRole("button", { name: /^Schedule for / }).click();
    await page.context().close();
    const again = await pageAs(browser, baseURL, "owner");
    const dlg2 = await reduceSeats(again);
    await expect(dlg2.getByText(/A seat cut is already scheduled: 10 → 8 seats/)).toBeVisible({ timeout: 60_000 });
    await again.context().close();
  });

  test("Step 2: Change plan → Business Standard, 10 seats → refused: the cut is named, 'Remove the scheduled seat cut in Manage seats first'; no Create button", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await changePlan(page);
    await expect(dlg.getByRole("alert")).toContainText(/A seat cut 10 → 8 is scheduled for the end of this term/, { timeout: 60_000 });
    await expect(dlg.getByRole("alert")).toContainText("Remove the scheduled seat cut in Manage seats first, then change the plan.");
    await expect(dlg.getByRole("button", { name: "Create plan change quote" })).toHaveCount(0);
    await page.context().close();
  });

  test("Step 3: Manage seats → Remove scheduled cut → Change plan again → the calculation shows and Create plan change quote is offered", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await reduceSeats(page);
    await expect(dlg.getByText(/A seat cut is already scheduled: 10 → 8 seats/)).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole("button", { name: "Remove scheduled cut" }).click();
    await expect(dlg.getByText(/A seat cut is already scheduled/)).toHaveCount(0, { timeout: 30_000 });
    await page.context().close();
    const again = await pageAs(browser, baseURL, "owner");
    const pc = await changePlan(again);
    await expect(pc.getByTestId("change-plan-calc")).toBeVisible({ timeout: 60_000 });
    await expect(pc.getByRole("button", { name: "Create plan change quote" })).toBeVisible();
    await again.context().close();
  });
});
