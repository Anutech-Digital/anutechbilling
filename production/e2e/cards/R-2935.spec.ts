/**
 * Card test — R-2935 "Banking: FD ka byaaj aur TDS alag bank line mein ho to bhi book ho"
 * (a bank that pays a closed FD on three lines: principal, interest, and the TDS it cut).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2935` (needs migration 20261118233537 on the local DB).
 *
 * The card's case is a real company's HDFC statement (staging); here the same three lines are made on
 * the local test company, fresh on every run and removed again after it (fixed ids, local docker DB only):
 *   · bank account "CT R2935 Current ··2935" and FD account "CT R2935 FD 50301205948354" (₹10,00,000)
 *   · "FD REDEEM PRINCIPAL -50301205948354/1" +₹10,00,000 — already reconciled as an own transfer from
 *     the FD (the app's own RPC, as the company's owner) → the FD's balance is ₹0
 *   · "FD REDEEM INTEREST -50301205948354/1" +₹8,014   → Step 1
 *   · "FD REDEEM TAX - 50301205948354/1"     −₹801     → Step 2
 *   · "FD REDEEM PRINCIPAL -50309999999999/1" +₹5,00,000 (another FD's principal, not reconciled) → Step 3
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const CARD = "R-2935";
const ACCT = "c2935000-0000-4000-8000-000000000a01";
const FD = "c2935000-0000-4000-8000-000000000a02";
const TXN_PRINCIPAL = "c2935000-0000-4000-8000-000000000011";
const TXN_INTEREST = "c2935000-0000-4000-8000-000000000012";
const TXN_TAX = "c2935000-0000-4000-8000-000000000013";
const TXN_OTHER_PRINCIPAL = "c2935000-0000-4000-8000-000000000014";
const FD_NAME = "CT R2935 FD 50301205948354";

/* The tax line first (its delete removes the TDS row and clears the interest row), then every line of the two
   accounts (the interest row goes with its line), then the accounts. Scoped to E2E Test Co + this spec's fixed ids. */
const CLEAN = `
  delete from public.bank_transactions where tenant_id = ${E2E_TENANT_SQL} and id = '${TXN_TAX}';
  delete from public.tds_receivable where tenant_id = ${E2E_TENANT_SQL} and notes like '%bank line ${TXN_TAX}';
  delete from public.bank_transactions where tenant_id = ${E2E_TENANT_SQL} and bank_account_id in ('${ACCT}', '${FD}');
  delete from public.bank_accounts where tenant_id = ${E2E_TENANT_SQL} and id in ('${ACCT}', '${FD}');`;

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
    insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, account_number_last4, opening_balance, opening_balance_date) values
      ('${ACCT}', ${E2E_TENANT_SQL}, 'CT R2935 Current', 'HDFC Bank', 'current', '2935', 200000, current_date - 60),
      ('${FD}', ${E2E_TENANT_SQL}, '${FD_NAME}', 'HDFC Bank', 'fixed_deposit', '8354', 1000000, current_date - 60);
    insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
      ('${TXN_PRINCIPAL}', ${E2E_TENANT_SQL}, '${ACCT}', current_date - 2, 'FD REDEEM PRINCIPAL -50301205948354/1', 0, 1000000, 'csv_upload'),
      ('${TXN_INTEREST}', ${E2E_TENANT_SQL}, '${ACCT}', current_date - 2, 'FD REDEEM INTEREST -50301205948354/1', 0, 8014, 'csv_upload'),
      ('${TXN_TAX}', ${E2E_TENANT_SQL}, '${ACCT}', current_date - 2, 'FD REDEEM TAX - 50301205948354/1', 801, 0, 'csv_upload'),
      ('${TXN_OTHER_PRINCIPAL}', ${E2E_TENANT_SQL}, '${ACCT}', current_date - 1, 'FD REDEEM PRINCIPAL -50309999999999/1', 0, 500000, 'csv_upload');
    set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true);
    select public.reconcile_bank_txn_as_transfer('${TXN_PRINCIPAL}', '${FD}');
    commit;`);
}

const lineMatch = (txn: string): string =>
  localDb(CARD).one(`select coalesce(matched_to_type, 'unmatched') from public.bank_transactions where id = '${txn}';`);
/** "amount|tds_amount|principal_amount|source" of the interest booked from the interest line ("" = none). */
const interestRow = (): string =>
  localDb(CARD).one(`select amount || '|' || tds_amount || '|' || principal_amount || '|' || coalesce(source, '') from public.other_incomes where bank_txn_id = '${TXN_INTEREST}';`);
/** "tds_amount|gross_amount|net_paid|section" of the TDS row behind the tax line ("" = none). */
const tdsRow = (): string =>
  localDb(CARD).one(`select r.tds_amount || '|' || r.gross_amount || '|' || r.net_paid || '|' || r.section from public.tds_receivable r
    join public.bank_transactions t on t.matched_to_type = 'tds_receivable' and t.matched_to_id = r.id where t.id = '${TXN_TAX}';`);
const incomeTotal = (): string =>
  localDb(CARD).one(`select coalesce(sum(o.amount), 0) from public.other_incomes o join public.bank_transactions t on t.id = o.bank_txn_id where t.bank_account_id = '${ACCT}';`);

/** The account's Unmatched list, hydrated (the other FD's principal line is always on it). */
async function openUnmatched(page: Page): Promise<void> {
  await openAppPage(page, `/accounting/banking/${ACCT}?status=unmatched`);
  await waitForHydrated(page, page.locator(`tr[data-txn-id="${TXN_OTHER_PRINCIPAL}"]`));
  // The principal that is already an own transfer from the FD is not on the Unmatched list.
  await expect(page.locator(`tr[data-txn-id="${TXN_PRINCIPAL}"]`)).toHaveCount(0);
}

/** Line → Reconcile; resolves with the sheet. */
async function openReconcile(page: Page, txn: string): Promise<Locator> {
  const row = page.locator(`tr[data-txn-id="${txn}"]`);
  const reconcile = row.getByRole("button", { name: /^Reconcile$/ });
  await expect(reconcile).toBeVisible({ timeout: 60_000 });
  await reconcile.click();
  const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  return dlg;
}

/** Money-in line → Reconcile → Other / manual; resolves once "Interest or other income?" shows. */
async function openOtherManual(page: Page, txn: string): Promise<{ dlg: Locator; income: Locator }> {
  const dlg = await openReconcile(page, txn);
  const income = dlg.getByRole("region", { name: "Income that is not a sale" });
  const tile = dlg.getByRole("radio", { name: /^Other \/ manual/ });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  // A tile click can be lost while the sheet is still loading — click until the income form shows.
  await expect(async () => {
    if (!(await income.isVisible())) await tile.click();
    await expect(income).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  return { dlg, income };
}

test.describe("R-2935 card test", () => {
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

  test("Step 1: the FD REDEEM INTEREST line (₹8,014) → Reconcile → Other / manual: Interest received · Fixed deposit · the FD, FD closed NOT ticked → Book ₹8,014 as interest received", async () => {
    await openUnmatched(page);
    const { dlg, income } = await openOtherManual(page, TXN_INTEREST);

    // Pre-picked from the narration: interest, from the FD it names — and NOT the closure split.
    await expect(income.getByRole("button", { name: "Interest received" })).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
    await expect(income.getByRole("button", { name: "Fixed deposit" })).toHaveAttribute("aria-pressed", "true");
    const fd = income.getByRole("combobox", { name: "FD account" });
    await expect(fd.locator("option:checked")).toContainText(FD_NAME, { timeout: 60_000 });
    await expect(income.getByRole("checkbox", { name: /FD closed/ })).not.toBeChecked();
    await expect(income.getByText(/looks like an FD coming back/)).toHaveCount(0);
    await expect(income.getByText("Interest income ₹8,014")).toBeVisible();

    const save = dlg.getByTestId("reconcile-footer").getByRole("button", { name: "Book ₹8,014 as interest received" });
    await expect(save).toBeEnabled({ timeout: 60_000 });
    await save.click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });

    // Booked: ₹8,014 interest, no principal in it, no TDS yet; the FD's balance is untouched (still ₹0).
    await expect.poll(interestRow, { timeout: 30_000 }).toBe("8014|0|0|fd");
    expect(lineMatch(TXN_INTEREST)).toBe("other_income");
    expect(incomeTotal(), "only the interest is income — never the ₹10,00,000 principal").toBe("8014");
    await expect(page.locator(`tr[data-txn-id="${TXN_INTEREST}"]`)).toHaveCount(0, { timeout: 60_000 });
  });

  test("Step 2: the FD REDEEM TAX line (₹801) → Reconcile opens on Tax → TDS cut by bank, the ₹8,014 interest picked → Book ₹801 as TDS receivable", async () => {
    await openUnmatched(page);
    const dlg = await openReconcile(page, TXN_TAX);

    // The Tax tile opens by itself on "TDS cut by bank" — not the TDS challan, not an expense.
    await expect(dlg.getByRole("button", { name: "TDS cut by bank" })).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
    const form = dlg.getByTestId("interest-tds-section");
    await expect(form.getByText(/TDS receivable/)).toBeVisible();
    const pick = form.getByRole("combobox", { name: "Interest this TDS was cut on" });
    await expect(pick.locator("option:checked")).toContainText("₹8,014", { timeout: 60_000 });
    await expect(pick.locator("option:checked")).toContainText(FD_NAME);
    await expect(form.getByText(/is 10% of the ₹8,014 interest/)).toBeVisible();
    await expect(form.getByText("₹7,213")).toBeVisible();

    const save = dlg.getByTestId("reconcile-footer").getByRole("button", { name: "Book ₹801 as TDS receivable" });
    await expect(save).toBeEnabled({ timeout: 60_000 });
    await save.click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });

    // TDS receivable ₹801 (194A) on ₹8,014 gross, ₹7,213 net; the interest income is still ₹8,014.
    await expect.poll(tdsRow, { timeout: 30_000 }).toBe("801|8014|7213|194A");
    expect(lineMatch(TXN_TAX)).toBe("tds_receivable");
    expect(interestRow()).toBe("8014|801|0|fd");
    expect(incomeTotal()).toBe("8014");
    await expect(page.locator(`tr[data-txn-id="${TXN_TAX}"]`)).toHaveCount(0, { timeout: 60_000 });
  });

  test("Step 3: an FD REDEEM PRINCIPAL line (₹5,00,000) → Other / manual → Interest received: the save is disabled and says it is principal, not income", async () => {
    await openUnmatched(page);
    const { dlg, income } = await openOtherManual(page, TXN_OTHER_PRINCIPAL);
    await expect(income.getByRole("button", { name: "Interest received" })).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });

    const footer = dlg.getByTestId("reconcile-footer");
    const why = /This line is the FD principal coming back, not income/;
    await expect(await onlyOne(footer.getByText(why), "the reason next to the save")).toBeVisible();
    await expect(footer.getByRole("button", { name: /as interest received/ })).toBeDisabled();

    await dlg.getByRole("button", { name: "Close" }).first().click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    expect(lineMatch(TXN_OTHER_PRINCIPAL)).toBe("unmatched");
    expect(incomeTotal(), "the principal was not booked as income").toBe("8014");
  });
});
