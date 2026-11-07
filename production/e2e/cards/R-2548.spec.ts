/**
 * Card test — R-2548 "Bill renewal · part 1 of next year" (R-2554).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2548`.
 *
 * Data (made fresh on every run, E2E Test Co only — R-2569: its OWN scenario, no other local data):
 * the local scenario `renewal-parts` (scripts/dev/scenario.mjs — local docker DB only) is reloaded
 * first: three customers only this spec uses. (It was `small-leftover`, which R-2544's card test
 * reloads too — that reload took away the customers / subscriptions this spec had just used.)
 * The reload also removes any subscription an earlier run added. Then step 1 adds, through the real
 * "Add / Onboard Subscription" form ("Opening — already billed & paid before" so nothing is billed):
 *   A. SCN Part Bill Studio — Annual · Half-yearly · 10 seats × ₹500 · start = today + 30 days − 1 year
 *      (7 Dec 2025 when run on 7 Nov 2026 — the card's own example) → renews in 30 days.
 *   B. SCN Part Bill Late Co — the same plan renewing in 3 days: Payment Follow-up lists only renewals due
 *      in ≤ 7 days (RENEWAL_URGENT_DAYS), so A (30 days) can never show there; B checks the same rule there.
 *   C. SCN Part Bill Yearly — Annual · paid Yearly (one payment) renewing in 30 days → "Send renewal quote".
 * Clean-up: once every step of the run has finished, `scenario.mjs renewal-parts --clear` removes the
 * three customers and the subscriptions the test added — nothing stays in the local DB.
 * The card says "Renews on 6 Dec 2026"; the form itself fills 7 Dec 2026 for a 7 Dec 2025 start and
 * says "Term ends 6 Dec 2026" — the test keeps the form's own renewal date (6 Dec is the term end).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const BUTTON = "Bill renewal · part 1 of next year";
const SCENARIO = "renewal-parts";
const A = "SCN Part Bill Studio";
const B = "SCN Part Bill Late Co";
const C = "SCN Part Bill Yearly";

/* ── dates (IST calendar, as the app shows them: "7 Dec 2026") ── */
function istToday(): Date {
  const s = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00Z`);
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shown = (d: Date) => `${d.getUTCDate()} ${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;

const today = istToday();
const renewA = addDays(today, 30);           // A + C renew in 30 days (Renewals tab "8–30")
const startA = addMonths(renewA, -12);
const renewB = addDays(today, 3);            // B renews in 3 days (Payment Follow-up horizon ≤ 7)
const startB = addMonths(renewB, -12);
const termEndA = addDays(addMonths(renewA, 12), -1);
const part1EndA = addDays(addMonths(renewA, 6), -1);
const expectedLineA = `Renewal for ${shown(renewA)}–${shown(termEndA)} · part 1 (${shown(renewA)}–${shown(part1EndA)}): 10 × ₹3,000`;

/**
 * Reload the scenario ONCE per run. After a failed step Playwright starts a new worker and runs
 * beforeAll again — reloading then would delete the subscriptions step 1 made, so the later steps
 * would fail for the wrong reason. The runner process (the worker's parent) is the same for the
 * whole run, so a marker named after it says "already loaded in this run".
 */
const runMarker = (what: string) => path.join(os.tmpdir(), `card-test-R-2548-${process.ppid}.${what}`);
const STEP_COUNT = 5; // the tests in this file — clean-up waits until every one has finished

function loadScenarioOncePerRun(): void {
  const marker = runMarker("loaded");
  if (fs.existsSync(marker)) return;
  scenario();
  fs.writeFileSync(marker, new Date().toISOString());
}

/** Load (fresh) or `--clear` this spec's own scenario — LOCAL docker DB only (scenario.mjs refuses anything else). */
function scenario(...flags: string[]): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...flags], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario ${SCENARIO} ${flags.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

/** Note one finished step; true once every step of this run has finished. */
function stepFinished(title: string): boolean {
  const file = runMarker("done");
  fs.appendFileSync(file, `${title}\n`);
  return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).size >= STEP_COUNT;
}

async function pick(page: Page, combo: RegExp, option: RegExp): Promise<void> {
  await page.getByRole("combobox", { name: combo }).first().click();
  // The customer list loads when the dialog opens — a busy dev server can take longer than a click's 10 s.
  const item = page.getByRole("option", { name: option }).first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.click();
}

/** Subscriptions → Add / Onboard Subscription → fill → "Opening — already billed & paid" → save. */
async function addSubscription(page: Page, o: { customer: string; domain: string; frequency: RegExp; start: Date }): Promise<void> {
  await openAppPage(page, "/subscriptions", /^Subscriptions$/);
  await page.getByRole("button", { name: /^Add Subscription$/ }).click();
  const dlg = page.getByRole("dialog", { name: "Add / Onboard Subscription" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await pick(page, /^Existing Customer/, new RegExp(`^${o.customer}`));
  const domain = dlg.getByLabel(/^Primary Customer Domain/);
  if (!(await domain.inputValue())) await domain.fill(o.domain);
  await pick(page, /^Commitment/, /^Annual commitment/);
  await pick(page, /^Payment frequency/, o.frequency);
  await dlg.getByLabel(/^License Seats/).fill("10");
  await dlg.getByLabel(/^Unit Price/).fill("500");
  await dlg.getByLabel(/^Start Date/).fill(iso(o.start));
  // The form moves "Renews on" itself to keep a 12-month term; read it back.
  await expect(dlg.getByLabel(/^Renews on/)).toHaveValue(iso(addMonths(o.start, 12)));
  await dlg.getByRole("button", { name: /^Opening/ }).click();
  // R-2569: on a busy dev server the picked customer's name + domain boxes were seen EMPTY at save time
  // (7 Nov, twice, always the 2nd form of the run; the pick itself still showed) → the form refused
  // to save. Check right before saving; pick the customer again if they were wiped, and say so.
  const nameBox = dlg.getByLabel(/^Customer Company Name/);
  if ((await nameBox.inputValue()) !== o.customer) {
    test.info().annotations.push({ type: "note", description: `${o.customer}: name/domain boxes were empty before save — picked the customer again.` });
    // Picking the same option again fires nothing — clear first ("Type New Customer / Clear Selection").
    await pick(page, /^Existing Customer/, /Type New Customer/);
    await pick(page, /^Existing Customer/, new RegExp(`^${o.customer}`));
    await expect(nameBox).toHaveValue(o.customer);
    if (!(await domain.inputValue())) await domain.fill(o.domain);
  }
  await dlg.getByRole("button", { name: /Activate Subscription/ }).click();
  try {
    await expect(dlg).toBeHidden({ timeout: 60_000 });
  } catch (e) {
    const toasts = (await page.locator("[data-sonner-toast]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    throw new Error(`${o.customer}: the form did not save${toasts.length ? ` — toast: ${toasts.join(" | ")}` : ""}. ${(e as Error).message}`);
  }
}

/** The Renewals row of `customer` (tab "8–30"). */
async function renewalsRow(page: Page, customer: string): Promise<Locator> {
  await openAppPage(page, "/renewals", /^Renewals$/);
  await page.getByRole("tab", { name: /^8–30/ }).click();
  await page.getByRole("searchbox", { name: /Search renewals/ }).fill(customer);
  const row = page.locator("main table tbody tr").filter({ hasText: customer });
  await expect(row.first()).toBeVisible({ timeout: 60_000 });
  return row.first();
}

test.describe("R-2548 — end of an annual commitment billed in parts: 'Bill renewal · part 1 of next year'", () => {
  onlyInCardTests();

  test.beforeAll(() => {
    if (CARD_TESTS_ON) loadScenarioOncePerRun();
  });

  // Clean-up after the LAST step only: a failed step also ends its worker (afterAll runs then too),
  // and the steps after it still need the data.
  let cleanUp = false;
  test.afterEach(({}, info) => {
    if (CARD_TESTS_ON && stepFinished(info.title)) cleanUp = true;
  });
  test.afterAll(() => {
    if (cleanUp) scenario("--clear");
  });

  test("Step 1: Add / Onboard Subscription — Annual, Half-yearly, 10 seats × ₹500, start a year before the renewal → saved", async ({ browser, baseURL }) => {
    test.setTimeout(480_000); // three forms on a busy dev server — 180 s was not enough (7 Nov run)
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await addSubscription(page, { customer: A, domain: "scn-partbill-studio.example", frequency: /^Half-yearly/, start: startA });
      await addSubscription(page, { customer: B, domain: "scn-partbill-late.example", frequency: /^Half-yearly/, start: startB });
      await addSubscription(page, { customer: C, domain: "scn-partbill-yearly.example", frequency: /^Yearly/, start: startA });
      test.info().annotations.push({ type: "note", description: `A: ${A} start ${shown(startA)}, renews ${shown(renewA)} · B: ${B} renews ${shown(renewB)} · C: ${C} yearly, renews ${shown(renewA)}.` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2a: Renewals — the row's button reads 'Bill renewal · part 1 of next year' with the 'Renewal for …' line", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const row = await renewalsRow(page, A);
      await expect(row.getByRole("button", { name: BUTTON })).toBeVisible();
      await expect(row.getByRole("button", { name: /^Bill next part$/ })).toHaveCount(0);
      const line = row.getByText(/^Renewal for /);
      await expect(line).toHaveText(expectedLineA);
      test.info().annotations.push({ type: "note", description: `Line: "${(await line.innerText()).trim()}"` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2b: Payment Follow-up — the same button and line on a half-yearly renewal due in ≤ 7 days", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // Age "All": the page opens on "Overdue" (R-2408), and B's renewal is 3 days AHEAD with nothing
      // else owed — so it is listed only under All / Not due (R-2569; the old shared customer had an
      // overdue bill, which is why the row used to show).
      await openAppPage(page, "/collections?age=all", /^Payment Follow-up$/);
      await page.getByRole("searchbox", { name: /Search customer/ }).fill(B);
      const row = page.locator("main table tbody tr").filter({ hasText: B }).first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await row.getByRole("button", { name: new RegExp(`^Show all \\d+ lines? for ${B}`) }).click();
      await expect(row.getByRole("button", { name: BUTTON })).toBeVisible({ timeout: 30_000 });
      const termEndB = addDays(addMonths(renewB, 12), -1);
      const part1EndB = addDays(addMonths(renewB, 6), -1);
      const want = `Renewal for ${shown(renewB)}–${shown(termEndB)} · part 1 (${shown(renewB)}–${shown(part1EndB)}): 10 × ₹3,000`;
      await expect(row.getByText(/^Renewal for /)).toHaveText(want);
      test.info().annotations.push({ type: "note", description: `Payment Follow-up line: "${want}". (A renews in 30 days — Payment Follow-up lists renewals only ≤ 7 days, so B is used here.)` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3a: Click the button → dialog 'Bill renewal · part 1 of next year — proforma', first period starts on the renewal date; Cancel makes nothing", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const row = await renewalsRow(page, A);
      await row.getByRole("button", { name: BUTTON }).click();
      const dlg = page.getByRole("dialog", { name: `${BUTTON} — proforma` });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      const first = dlg.getByRole("listitem").first();
      await expect(first).toBeVisible({ timeout: 30_000 });
      expect((await first.innerText()).replace(/\s+/g, " "), "first period listed").toContain(`${shown(renewA)}–${shown(part1EndA)}`);
      const period = (await first.innerText()).replace(/\s+/g, " ").trim();
      await dlg.getByRole("button", { name: /^Cancel$/ }).click();
      await expect(dlg).toBeHidden();
      // Nothing made: the row still offers the same button (no proforma for that part yet).
      const again = await renewalsRow(page, A);
      await expect(again.getByRole("button", { name: BUTTON })).toBeVisible();
      test.info().annotations.push({ type: "note", description: `Dialog first period: "${period}". After Cancel the row still says '${BUTTON}'.` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3b: An annual subscription paid in one go still shows 'Send renewal quote'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const row = await renewalsRow(page, C);
      await expect(row.getByRole("button", { name: /^Send renewal quote$/ })).toBeVisible();
      await expect(row.getByRole("button", { name: BUTTON })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
