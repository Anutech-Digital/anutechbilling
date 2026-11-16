/**
 * Card test — R-2674 "Balance Sheet: loans given / staff loans due back within 12 months show under
 * Current assets (choice per loan)".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2674`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed again after):
 *   · loan given "CT R2674 No Date"   ₹3,00,000, no due date, not answered
 *   · loan given "CT R2674 Due Soon"  ₹1,00,000, due in 60 days   → current by its date
 *   · loan given "CT R2674 Due Later" ₹2,00,000, due in 800 days  → non-current by its date
 *   · staff loan "CT R2674 Staff"     ₹80,000
 * The company may hold other loans, so the Balance Sheet steps compare before / after (the lines move
 * by exactly ₹3,00,000 / ₹80,000 and Total Assets does not move).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const NO_DATE = "c2674000-0000-4000-8000-000000000001";
const DUE_SOON = "c2674000-0000-4000-8000-000000000002";
const DUE_LATER = "c2674000-0000-4000-8000-000000000003";
const STAFF = "c2674000-0000-4000-8000-000000000011";
const IDS = `'${NO_DATE}','${DUE_SOON}','${DUE_LATER}'`;

const GIVEN_CUR = "Loans given — current (due within 12 months)";
const GIVEN_NON = "Loans given — non-current (due after 12 months)";
const STAFF_CUR = "Employee loans — current (due within 12 months)";
const STAFF_NON = "Employee loans — non-current (due after 12 months)";
const GIVEN_ASK = "Loans given — no due date, not answered (counted as non-current)";

const CLEAN = `
  delete from public.activity_log where action = 'loan.due_within_12m_set' and entity_id in (${IDS},'${STAFF}');
  delete from public.loan_repayments where loan_id in (${IDS});
  delete from public.loans_given where id in (${IDS}) and tenant_id = ${E2E_TENANT_SQL};
  delete from public.employee_loan_repayments where loan_id = '${STAFF}';
  delete from public.employee_loans where id = '${STAFF}' and tenant_id = ${E2E_TENANT_SQL};`;

function clean(): void {
  localDb("R-2674").psql(`begin; ${CLEAN} commit;`);
}

function seed(): void {
  localDb("R-2674").psql(`
    begin;
    ${CLEAN}
    insert into public.loans_given (id, tenant_id, borrower_name, principal, given_on, repayment_plan, due_on, notes) values
      ('${NO_DATE}',   ${E2E_TENANT_SQL}, 'CT R2674 No Date',   300000, current_date - 20, 'one_shot', null,               'Card test R-2674 — local only'),
      ('${DUE_SOON}',  ${E2E_TENANT_SQL}, 'CT R2674 Due Soon',  100000, current_date - 20, 'one_shot', current_date + 60,  'Card test R-2674 — local only'),
      ('${DUE_LATER}', ${E2E_TENANT_SQL}, 'CT R2674 Due Later', 200000, current_date - 20, 'one_shot', current_date + 800, 'Card test R-2674 — local only');
    insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, kind, notes) values
      ('${STAFF}', ${E2E_TENANT_SQL}, 'CT R2674 Staff', 80000, current_date - 20, 'loan', 'Card test R-2674 — local only');
    commit;`);
}

/** Whole rupees of a Balance Sheet line ("₹3,00,000" / "(₹1,000)"); 0 when the line is not on the sheet. */
async function lineAmount(page: Page, label: string): Promise<number> {
  const name = page.locator("main").getByText(label, { exact: true });
  if ((await name.count()) === 0) return 0;
  const row = (await onlyOne(name, `Balance Sheet line "${label}"`)).locator("xpath=ancestor::*[contains(@class,'justify-between')][1]");
  const text = (await row.locator("span.font-mono").last().innerText()).trim();
  const n = Number(text.replace(/[^\d]/g, ""));
  return text.startsWith("(") ? -n : n;
}

async function openBalanceSheet(page: Page): Promise<void> {
  await openAppPage(page, "/accounting/balance-sheet", /Balance Sheet/i);
  // The sheet is loaded once the totals row is there (the loan lines come with the same data).
  await waitForHydrated(page, page.locator("main").getByText("Total Assets", { exact: true }));
}

async function sheet(page: Page) {
  await openBalanceSheet(page);
  return {
    givenCur: await lineAmount(page, GIVEN_CUR),
    givenNon: await lineAmount(page, GIVEN_NON),
    givenAsk: await lineAmount(page, GIVEN_ASK),
    staffCur: await lineAmount(page, STAFF_CUR),
    staffNon: await lineAmount(page, STAFF_NON),
    totalAssets: await lineAmount(page, "Total Assets"),
  };
}

/** The "Due back within 12 months?" control of one loan (desktop row — the mobile card copy is hidden at 1280px). */
function choice(page: Page, loanId: string): Locator {
  return page.locator(`[data-testid="due-within-12m-${loanId}"]`).filter({ visible: true });
}

async function answer(page: Page, loanId: string, value: "yes" | "no", saved: RegExp): Promise<void> {
  const sel = (await onlyOne(choice(page, loanId), "the Due back within 12 months? control")).getByRole("combobox");
  await expect(sel).toBeEnabled({ timeout: 60_000 });
  await sel.selectOption(value);
  await expect(page.getByText(saved).first()).toBeVisible({ timeout: 60_000 });
  await expect(sel).toHaveValue(value, { timeout: 60_000 });
}

test.describe("R-2674 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  let page: Page;
  let before: Awaited<ReturnType<typeof sheet>>;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    clean();
  });

  test("Step 1: Owner → Accounting → Loans given: the no-date loan asks 'Due back within 12 months?'; dated loans say where they show", async () => {
    await openAppPage(page, "/accounting/loans-given", /Loans given/i);
    await waitForHydrated(page, choice(page, NO_DATE));
    await expect(page.getByTestId("r2674-undecided")).toContainText(/no due date/);
    const sel = (await onlyOne(choice(page, NO_DATE))).getByRole("combobox");
    await expect(sel).toHaveValue("");
    await expect(sel).toHaveAccessibleName(/Due back within 12 months\? CT R2674 No Date/);
    await expect(await onlyOne(choice(page, DUE_SOON))).toHaveText("Balance Sheet: current (due within 12 months)");
    await expect(await onlyOne(choice(page, DUE_LATER))).toHaveText("Balance Sheet: non-current (due after 12 months)");
  });

  test("Step 2: Balance Sheet before the answer: the no-date ₹3,00,000 is its own line 'Loans given — no due date, not answered' and says who answers", async () => {
    before = await sheet(page);
    expect(before.givenCur).toBeGreaterThanOrEqual(100_000);          // CT R2674 Due Soon
    expect(before.givenNon).toBeGreaterThanOrEqual(200_000);          // CT R2674 Due Later
    expect(before.givenAsk).toBeGreaterThanOrEqual(300_000);          // CT R2674 No Date
    expect(before.staffCur).toBeGreaterThanOrEqual(80_000);           // staff loan: current by default
    const ask = (await onlyOne(page.locator("main").getByText(GIVEN_ASK, { exact: true }))).locator("xpath=ancestor::*[contains(@class,'justify-between')][1]");
    await expect(ask).toContainText(/with no due date — the owner or accountant answers "Due back within 12 months\?" on Loans given/);
  });

  test("Step 3: Loans given → answer Yes on the no-date loan → Balance Sheet: ₹3,00,000 moves to 'Loans given — current', Total Assets unchanged", async () => {
    await openAppPage(page, "/accounting/loans-given", /Loans given/i);
    await waitForHydrated(page, choice(page, NO_DATE));
    await answer(page, NO_DATE, "yes", /Saved — shown under Current assets/);
    const after = await sheet(page);
    expect(after.givenCur - before.givenCur).toBe(300_000);
    expect(before.givenAsk - after.givenAsk).toBe(300_000);
    expect(after.givenNon).toBe(before.givenNon);
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.staffCur).toBe(before.staffCur);
  });

  test("Step 4: answer No on the same loan → the ₹3,00,000 is in 'Loans given — non-current', and it no longer asks", async () => {
    await openAppPage(page, "/accounting/loans-given", /Loans given/i);
    await waitForHydrated(page, choice(page, NO_DATE));
    await answer(page, NO_DATE, "no", /Saved — shown as a non-current asset/);
    const after = await sheet(page);
    expect(after.givenCur).toBe(before.givenCur);
    expect(after.givenNon - before.givenNon).toBe(300_000);
    expect(before.givenAsk - after.givenAsk).toBe(300_000);
    expect(after.totalAssets).toBe(before.totalAssets);
  });

  test("Step 5: Loans & Salary Advances → the staff loan is Yes by default → No moves ₹80,000 to 'Employee loans — non-current'", async () => {
    await openAppPage(page, "/accounting/loans");
    await waitForHydrated(page, choice(page, STAFF));
    await expect((await onlyOne(choice(page, STAFF))).getByRole("combobox")).toHaveValue("yes");
    await answer(page, STAFF, "no", /Saved — shown as a non-current asset/);
    const after = await sheet(page);
    expect(before.staffCur - after.staffCur).toBe(80_000);
    expect(after.staffNon - before.staffNon).toBe(80_000);
    expect(after.totalAssets).toBe(before.totalAssets);
  });

  test("Step 6: Manager login → Balance Sheet shows the same split lines (totals only)", async ({ browser, baseURL }) => {
    const mgr = await pageAs(browser, baseURL, "manager");
    try {
      await openBalanceSheet(mgr);
      await onlyOne(mgr.locator("main").getByText(GIVEN_CUR, { exact: true }), "manager: Loans given — current");
      await onlyOne(mgr.locator("main").getByText(STAFF_NON, { exact: true }), "manager: Employee loans — non-current");
      await expect(mgr.locator("main").getByText("CT R2674 No Date")).toHaveCount(0);
    } finally {
      await mgr.context().close();
    }
  });

  test("Step 7: Current ratio wording / Schedule III presentation — a person judges", async () => {
    test.skip(true, "Looks / wording / CA's Schedule III view — not a machine check.");
  });
});
