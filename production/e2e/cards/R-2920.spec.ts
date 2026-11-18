/**
 * Card test — R-2920 "Banking: ek bank receipt ko do ya zyada 'Loans given' mein baanto"
 * (one money-in bank line split across two or more loans given).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2920` (needs migration 20261118102112 on the local DB).
 *
 * The card's own howToCheck names a real company's bank line (staging); here the same case is made
 * on the local test company, fresh on every run and removed again after it (fixed ids, local docker
 * DB only):
 *   · bank account "CT R2920 Current ··2920"
 *   · two interest-free loans given to "R2920 Borrower" through Loans given → Give a loan's own RPC
 *     (give_loan, as the company's owner): ₹40,000 (older) and ₹10,000
 *   · money-in line ₹50,000 "NEFT CR R2920 BORROWER HDFC" (names the borrower)   → both loans, pre-ticked
 *   · money-in line ₹60,000 "NEFT CR CT2920 WALKIN DEPOSIT" (names nobody)       → nothing ticked
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const CARD = "R-2920";
const ACCT = "c2920000-0000-4000-8000-000000000a01";
const TXN_SPLIT = "c2920000-0000-4000-8000-000000000011";
const TXN_NOBODY = "c2920000-0000-4000-8000-000000000012";
const BORROWER = "R2920 Borrower";
const LINE_SPLIT = "NEFT CR R2920 BORROWER HDFC";
const LINE_NOBODY = "NEFT CR CT2920 WALKIN DEPOSIT";

/* Receipts first, then the loans, then the lines and the account. Scoped to E2E Test Co + this spec's fixed account. */
const LOANS = `(select id from public.loans_given where tenant_id = ${E2E_TENANT_SQL} and (paid_from_account_id = '${ACCT}' or borrower_name = '${BORROWER}'))`;
const CLEAN = `
  delete from public.loan_repayments where tenant_id = ${E2E_TENANT_SQL} and (loan_id in ${LOANS} or bank_txn_id in ('${TXN_SPLIT}', '${TXN_NOBODY}'));
  delete from public.loans_given where id in ${LOANS};
  delete from public.bank_transactions where tenant_id = ${E2E_TENANT_SQL} and bank_account_id = '${ACCT}';
  delete from public.bank_accounts where tenant_id = ${E2E_TENANT_SQL} and id = '${ACCT}';`;

function clean(): void {
  localDb(CARD).psql(`begin; ${CLEAN} commit;`);
}

function seed(): void {
  const db = localDb(CARD);
  const owner = db.one(`select id from public.users where tenant_id = ${E2E_TENANT_SQL} and role = 'owner' order by created_at limit 1;`);
  if (!owner) throw new Error("E2E Test Co has no owner user");
  db.psql(`
    begin;
    ${CLEAN}
    insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance, opening_balance_date)
      values ('${ACCT}', ${E2E_TENANT_SQL}, 'CT R2920 Current', 'HDFC Bank', '2920', 200000, current_date - 60);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
      ('${TXN_SPLIT}', ${E2E_TENANT_SQL}, '${ACCT}', current_date - 2, '${LINE_SPLIT}', 0, 50000, 'csv_upload'),
      ('${TXN_NOBODY}', ${E2E_TENANT_SQL}, '${ACCT}', current_date - 1, '${LINE_NOBODY}', 0, 60000, 'csv_upload');
    set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true);
    select public.give_loan('${BORROWER}', 'person', 40000, current_date - 30, '${ACCT}');
    select public.give_loan('${BORROWER}', 'person', 10000, current_date - 20, '${ACCT}');
    commit;`);
}

/** "principal|status|principal got back" of the two planted loans, older first. */
function loans(): string[] {
  return localDb(CARD).psql(`select l.principal || '|' || l.status || '|' || coalesce((select sum(r.principal_part) from public.loan_repayments r where r.loan_id = l.id), 0)
    from public.loans_given l where l.id in ${LOANS} order by l.given_on;`);
}

function lineMatch(txn: string): string {
  return localDb(CARD).one(`select coalesce(matched_to_type, 'unmatched') from public.bank_transactions where id = '${txn}';`);
}

/** The account's Unmatched list, hydrated (the planted ₹60,000 line is always on it). */
async function openUnmatched(page: Page): Promise<void> {
  await openAppPage(page, `/accounting/banking/${ACCT}?status=unmatched`);
  await waitForHydrated(page, page.locator(`tr[data-txn-id="${TXN_NOBODY}"]`));
  // Unmatched really is on: the two "Loan given: …" payout lines (already reconciled to their loans) are not listed.
  await expect(page.locator("tr[data-txn-id]", { hasText: `Loan given: ${BORROWER}` })).toHaveCount(0);
}

/** Line → Reconcile → Loan / EMI; resolves with the sheet once "A receipt on a loan you gave?" lists the loans. */
async function openLoanTile(page: Page, txn: string): Promise<{ dlg: Locator; section: Locator; mine: Locator }> {
  const row = page.locator(`tr[data-txn-id="${txn}"]`);
  const reconcile = row.getByRole("button", { name: /^Reconcile$/ });
  await expect(reconcile).toBeVisible({ timeout: 60_000 });
  await reconcile.click();
  const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
  const section = dlg.getByTestId("loan-given-receipt-section");
  const tile = dlg.getByRole("radio", { name: /^Loan \/ EMI/ });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  // A tile click can be lost while the sheet is still loading — click until the loan section shows.
  await expect(async () => {
    if (!(await section.isVisible())) await tile.click();
    await expect(section).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  const mine = section.getByRole("group", { name: "Which loan given" }).getByRole("listitem").filter({ hasText: BORROWER });
  await expect(mine, "both R2920 Borrower loans are listed").toHaveCount(2, { timeout: 60_000 });
  return { dlg, section, mine };
}

test.describe("R-2920 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
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

  test("Step 1: a line that names nobody ticks no loan; an amount above what a loan owes keeps Save off", async () => {
    await openUnmatched(page);
    const { dlg, section, mine } = await openLoanTile(page, TXN_NOBODY);

    // Nobody is named in "NEFT CR CT2920 WALKIN DEPOSIT" → nothing ticked (never just the first loan in the list).
    await expect(section.getByText("A receipt on a loan you gave?")).toBeVisible();
    await expect(section.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(dlg.getByRole("button", { name: "Pick the loan" })).toBeDisabled();

    // Tick both of the borrower's loans: they owe ₹50,000 together, the line is ₹60,000 → does not add up.
    // (A line that names nobody lists the loans in the page's own order — find each by what it owes.)
    const big = await onlyOne(mine.filter({ hasText: "owes ₹40,000" }), "the ₹40,000 loan");
    const small = await onlyOne(mine.filter({ hasText: "owes ₹10,000" }), "the ₹10,000 loan");
    await big.getByRole("checkbox").check();
    await small.getByRole("checkbox").check();
    const first = big.getByRole("spinbutton", { name: `Amount for ${BORROWER}, receipt 1` });
    const second = small.getByRole("spinbutton", { name: `Amount for ${BORROWER}, receipt 1` });
    await expect(first).toHaveValue("40000");
    await expect(second).toHaveValue("10000");
    const tally = section.getByTestId("loan-given-tally");
    await expect(tally).toHaveText("Bank ₹60,000 ≠ ₹50,000 — ₹10,000 still to place");
    const save = dlg.getByRole("button", { name: "Reconcile to 2 loans" });
    await expect(save).toBeDisabled();

    // Push the missing ₹10,000 onto the ₹40,000 loan: the total now equals the line, but the loan owes only ₹40,000.
    await fillKept(first, "50000");
    await expect(tally).toHaveText("Bank ₹60,000 = ₹60,000 ✓");
    await expect(big.getByText("More than is owed — at most ₹40,000 can come in on this loan.")).toBeVisible();
    await expect(save).toBeDisabled();

    // Nothing was saved: line still unmatched, both loans open with nothing received.
    await dlg.getByRole("button", { name: "Close" }).first().click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    expect(lineMatch(TXN_NOBODY)).toBe("unmatched");
    expect(loans()).toEqual(["40000|open|0", "10000|open|0"]);
  });

  test("Step 2: Unmatched → the ₹50,000 line → Reconcile → Loan / EMI: both loans of the named borrower are ticked, ₹40,000 + ₹10,000, Bank ₹50,000 = ₹50,000 ✓", async () => {
    await openUnmatched(page);
    const { dlg, section, mine } = await openLoanTile(page, TXN_SPLIT);

    // The borrower named in the bank line: both loans ticked by themselves, the older (₹40,000) first.
    await expect(mine.nth(0)).toContainText("owes ₹40,000");
    await expect(mine.nth(1)).toContainText("owes ₹10,000");
    await expect(mine.nth(0).getByRole("checkbox")).toBeChecked();
    await expect(mine.nth(1).getByRole("checkbox")).toBeChecked();
    await expect(section.getByRole("checkbox", { checked: true }), "only the named borrower's loans are ticked").toHaveCount(2);
    const amounts = section.getByRole("spinbutton", { name: `Amount for ${BORROWER}, receipt 1` });
    await expect(amounts.nth(0)).toHaveValue("40000");
    await expect(amounts.nth(1)).toHaveValue("10000");
    await expect(mine.nth(0)).toContainText("Principal back ₹40,000 · interest ₹0 · clears the loan");
    await expect(mine.nth(1)).toContainText("Principal back ₹10,000 · interest ₹0 · clears the loan");
    await expect(section.getByTestId("loan-given-tally")).toHaveText("Bank ₹50,000 = ₹50,000 ✓");
    await expect(dlg.getByRole("button", { name: "Reconcile to 2 loans" })).toBeEnabled();
  });

  test("Step 3: \"Reconcile to 2 loans\" → the line leaves Unmatched, one receipt on each loan", async () => {
    const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
    await dlg.getByRole("button", { name: "Reconcile to 2 loans" }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    await expect.poll(loans, { timeout: 30_000 }).toEqual(["40000|closed|40000", "10000|closed|10000"]);
    expect(lineMatch(TXN_SPLIT)).toBe("loan_given");
    expect(localDb(CARD).psql(`select amount from public.loan_repayments where bank_txn_id = '${TXN_SPLIT}' order by amount desc;`)).toEqual(["40000", "10000"]);

    // On screen: the Unmatched list no longer has the line (the ₹60,000 one is still there).
    await expect(page.locator(`tr[data-txn-id="${TXN_SPLIT}"]`)).toHaveCount(0, { timeout: 60_000 });
    await openUnmatched(page);
    await expect(page.locator(`tr[data-txn-id="${TXN_SPLIT}"]`)).toHaveCount(0);
    await expect(page.locator(`tr[data-txn-id="${TXN_NOBODY}"]`)).toHaveCount(1);
  });

  test("Step 4: Accounting → Loans given → Show repaid: both R2920 Borrower loans are Repaid, nothing outstanding", async () => {
    await openAppPage(page, "/accounting/loans-given", /Loans given/);
    const table = page.locator("main table");
    const rows = table.locator("tbody tr").filter({ hasText: BORROWER });
    const showRepaid = page.getByRole("button", { name: /^Show repaid \(\d+\)$/ });
    await waitForHydrated(page, showRepaid);
    await expect(rows, "repaid loans are not in the open list").toHaveCount(0);
    await showRepaid.click();
    await expect(page.getByRole("button", { name: "Hide repaid" })).toBeVisible();
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    for (const given of ["₹40,000", "₹10,000"]) {
      const row = await onlyOne(rows.filter({ hasText: given }), `the ${given} loan to ${BORROWER}`);
      await expect(row.getByText("Repaid", { exact: true })).toBeVisible();
      await expect(row.locator("td").nth(2)).toContainText("₹0"); // Outstanding
      await expect(row.locator("td").nth(2)).toContainText(`1 receipt got · ${given}`);
    }
  });
});
