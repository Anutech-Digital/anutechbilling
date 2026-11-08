/**
 * Card test — R-2226 (G-ZOHO Billing A2): seats added to a subscription billed in parts are priced
 * at the PART's own rate — a whole month of a ₹3,240/yr seat billed monthly is ₹270, not ₹266 / ₹275.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2226`.
 *
 * Data: this spec's OWN scenario `seat-parts` (scripts/dev/scenario.mjs — local docker DB only),
 * loaded fresh once per run: SCN Seat Parts Co with "SCN Seat Parts Monthly" (billed monthly) and
 * "SCN Seat Parts Yearly" (paid yearly), 10 seats × ₹3,240/yr, term from the 1st two months ago.
 * The steps only open Manage seats and read the preview, then Cancel — no quote is made. After the
 * last step `scenario.mjs seat-parts --clear` removes the customer and both subscriptions.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const SCENARIO = "seat-parts";
const MONTHLY = "SCN Seat Parts Monthly";
const YEARLY = "SCN Seat Parts Yearly";

/* ── dates (IST calendar) ── */
function istToday(): Date {
  const s = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00Z`);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = istToday();
const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
const firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
const daysIn = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
/* Yearly row: the term ends (exclusive) on the 1st ten months from now. */
const termEndExcl = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 10, 1));
const yearlyDays = Math.round((termEndExcl.getTime() - firstOfMonth.getTime()) / 86_400_000);
const yearlyPerSeat = Math.round((3240 * yearlyDays) / 365);
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2226-${process.ppid}.${what}`);
const STEP_COUNT = 3;

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

/** Subscriptions → open the row → Manage seats → 1 seat, effective date → the open dialog. */
async function manageSeats(page: Page, plan: string, effective: Date): Promise<Locator> {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  const row = page.getByRole("button", { name: new RegExp(`^Open ${plan} for `) }).filter({ visible: true });
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  await row.first().click();
  await page.getByRole("button", { name: "Manage seats" }).first().click();
  const dlg = page.getByRole("dialog").filter({ hasText: "How many additional seats?" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await dlg.getByLabel("Additional seats").fill("1");
  await dlg.locator("#add-seats-effective-date").fill(iso(effective));
  return dlg;
}

async function cancel(dlg: Locator): Promise<void> {
  await dlg.getByRole("button", { name: /^Cancel$/ }).first().click();
  await expect(dlg).toBeHidden({ timeout: 30_000 });
}

test.describe("R-2226 — seats on a subscription billed in parts use the part's own rate", () => {
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

  test("Step 1: Monthly sub → Manage seats, 1 seat from the 1st of this month → 'Part rate ₹270/seat (1 month of ₹3,240/yr) × N of N days', ₹270 per seat", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await manageSeats(page, MONTHLY, firstOfMonth);
    const n = daysIn(firstOfMonth);
    await expect(dlg.getByTestId("add-seats-part-formula")).toHaveText(`Part rate ₹270/seat (1 month of ₹3,240/yr) × ${n} of ${n} days`, { timeout: 30_000 });
    await expect(dlg.getByText("Subtotal (1 × ₹270)")).toBeVisible();
    test.info().annotations.push({ type: "note", description: `Formula: Part rate ₹270/seat (1 month of ₹3,240/yr) × ${n} of ${n} days; Subtotal (1 × ₹270)` });
    await cancel(dlg);
    await page.context().close();
  });

  test("Step 2: Same sub, effective date the 1st of LAST month → two parts, each a whole month → ₹540 per seat", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await manageSeats(page, MONTHLY, firstOfLastMonth);
    const a = daysIn(firstOfLastMonth);
    const b = daysIn(firstOfMonth);
    await expect(dlg.getByTestId("add-seats-part-formula")).toHaveText(
      `Part rate ₹270/seat (1 month of ₹3,240/yr) × ${a} of ${a} days + Part rate ₹270/seat (1 month of ₹3,240/yr) × ${b} of ${b} days`, { timeout: 30_000 });
    await expect(dlg.getByText("Subtotal (1 × ₹540)")).toBeVisible();
    await cancel(dlg);
    await page.context().close();
  });

  test("Step 3: Yearly-paid sub → no part line, 'Pro-rata factor' as before, per seat = ₹3,240 × days left ÷ 365", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const dlg = await manageSeats(page, YEARLY, firstOfMonth);
    await expect(dlg.getByText("Pro-rata factor")).toBeVisible({ timeout: 30_000 });
    await expect(dlg.getByTestId("add-seats-part-formula")).toHaveCount(0);
    await expect(dlg.getByText(`Subtotal (1 × ${inr(yearlyPerSeat)})`)).toBeVisible();
    test.info().annotations.push({ type: "note", description: `Yearly: ${yearlyDays}/365 → ${inr(yearlyPerSeat)} per seat` });
    await cancel(dlg);
    await page.context().close();
  });
});
