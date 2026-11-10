/**
 * Card test — R-2227 (G-ZOHO Billing A3): Change plan mid-term on a licence subscription
 * (Business Starter → Business Standard): new plan for the days left, less the unused old plan
 * (credited only up to what was billed / paid — R-2255), net → a draft quote; the plan changes on payment.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2227`.
 *
 * Data: this spec's OWN scenario `plan-change` (scripts/dev/scenario.mjs — local docker DB only), loaded
 * fresh once per run: SCN Plan Change Co, subscription "SCN Plan Change Starter" (E2E-GW-STR), 10 seats ×
 * ₹3,240/yr paid yearly from the 1st two months ago, invoice INV-SCN-PC-1 ₹38,232 paid in full.
 * Step 3 makes a draft quote on that customer; after the last step `scenario.mjs plan-change --clear`
 * removes the customer, subscription, quotes and invoices.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const SCENARIO = "plan-change";
const PLAN = "SCN Plan Change Starter";
const STANDARD_ID = "E2E-GW-STD";
const CHEAPER_ID = "E2E-R2213-YEARLY";
const SUB_ID = "c2227000-0000-4000-8000-000000000002";

/* ── dates (IST calendar) ── */
function istToday(): Date {
  const s = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00Z`);
}
const today = istToday();
const termStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
const termEndExcl = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 10, 1));
const DAY = 86_400_000;
const termDays = Math.round((termEndExcl.getTime() - termStart.getTime()) / DAY);
const daysLeft = Math.round((termEndExcl.getTime() - today.getTime()) / DAY);
const oldPerSeat = Math.round((3240 * daysLeft) / termDays);
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2227-${process.ppid}.${what}`);
const STEP_COUNT = 4;

function scenario(...flags: string[]): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...flags], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario ${SCENARIO} ${flags.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}
function loadScenarioOncePerRun(): void {
  const marker = runMarker("loaded");
  if (fs.existsSync(marker)) return;
  scenario();
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

/** Subscriptions → open the row → Change plan → pick the plan, 10 seats → the open dialog. */
async function changePlan(page: Page, toId: string): Promise<Locator> {
  await openSub(page);
  const btn = page.getByRole("button", { name: "Change plan" }).first();
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  const dlg = page.getByRole("dialog").filter({ hasText: "Subscription · Change plan" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await dlg.getByLabel("New plan").selectOption(toId);
  await dlg.getByLabel("Seats").fill("10");
  return dlg;
}

test.describe("R-2227 — Change plan mid-term (Starter → Standard)", () => {
  onlyInCardTests();

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

  test("Step 1: SCN Plan Change Starter → Change plan → Business Standard, 10 seats → new plan for the days left, less the WHOLE unused Starter (paid in full), net to pay", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await changePlan(page, STANDARD_ID);
    const calc = dlg.getByTestId("change-plan-calc");
    await expect(calc).toBeVisible({ timeout: 60_000 });
    await expect(calc.getByText(`Less unused ${PLAN}: 10 × ${inr(oldPerSeat)}`)).toBeVisible();
    await expect(calc.getByText(`−${inr(oldPerSeat * 10)}`)).toBeVisible();
    await expect(calc.getByText(/only .* is credited/)).toHaveCount(0);
    await expect(dlg.getByTestId("change-plan-net")).toHaveText(/^₹[\d,]+$/);
    test.info().annotations.push({ type: "note", description: `${daysLeft}/${termDays} days; unused ${inr(oldPerSeat * 10)}; net ${await dlg.getByTestId("change-plan-net").textContent()}` });
    await dlg.getByRole("button", { name: /^Cancel$/ }).first().click();
    await page.context().close();
  });

  test("Step 2: a CHEAPER plan is refused — 'takes effect at renewal', no Create button", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await changePlan(page, CHEAPER_ID);
    await expect(dlg.getByRole("alert")).toContainText("takes effect at renewal", { timeout: 60_000 });
    await expect(dlg.getByRole("button", { name: "Create plan change quote" })).toHaveCount(0);
    await dlg.getByRole("button", { name: /^Cancel$/ }).first().click();
    await page.context().close();
  });

  test("Step 3: Create plan change quote → the quote opens with the plan-change line and the same net", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await changePlan(page, STANDARD_ID);
    const net = dlg.getByTestId("change-plan-net");
    await expect(net).toBeVisible({ timeout: 60_000 });
    const netText = (await net.textContent())?.trim() ?? "";
    await dlg.getByRole("button", { name: "Create plan change quote" }).click();
    await page.waitForURL(/\/quotes\/[^/]+$/, { timeout: 60_000 });
    await expect(page.getByText(/change from SCN Plan Change Starter/).first()).toBeVisible({ timeout: 60_000 });
    const digits = netText.replace(/[^d,]/g, "");
    await expect(page.getByText(new RegExp(digits)).first()).toBeVisible();
    test.info().annotations.push({ type: "note", description: `Quote ${page.url().split("/").pop()} net ${netText}` });
    await page.context().close();
  });

  test("Step 4: Sales login cannot change a plan — the server answers 403, no quote is made", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "sales");
    const res = await page.request.post(`/api/subscriptions/${SUB_ID}/change-plan`, { data: { to_item_id: STANDARD_ID, seats: 10, preview: true } });
    expect(res.status()).toBe(403);
    await page.context().close();
  });
});
