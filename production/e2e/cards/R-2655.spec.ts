/**
 * Card test — R-2655 (G-RECON N6, part 1): Banking → "Match Zoho expenses" shows, for every expense
 * imported from Zoho and paid from a bank account, the one open debit that is it ("clean match") or
 * why there is none ("need a look"). Preview only — nothing is booked.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2655`.
 *
 * Data: planted by this spec on the LOCAL docker DB (fixed ids, planted once — the feature is read
 * only, so a second run finds the same rows): account "SCN Zoho HDFC" (current) with
 *   - Zoho expense SCN-Z-A in two category rows ₹2,655 + ₹1,345, paid 2 Nov, and ONE debit ₹4,000
 *     "POS SCN ZOHO AMZN" on 4 Nov → clean match (2 parts);
 *   - Zoho expense SCN-Z-B ₹7,655 paid 3 Nov and no debit → no bank line;
 *   - Zoho expense SCN-Z-C ₹1,655 paid 5 Nov and TWO debits of ₹1,655 → more than one match.
 * The expense rows carry zoho_doc_id, which only the import may write (tg_purchases_zoho_doc_guard):
 * the plant uses the import's own transaction-local switch `app.zoho_purchase_import`, inside one
 * transaction, for these fixed ids in E2E Test Co only — the local test company has no Zoho to import from.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const ACC = "c2655000-0000-4000-8000-0000000000a1";
const BATCH = "c2655000-0000-4000-8000-0000000000b1";
const T = (n: number) => `c2655000-0000-4000-8000-00000000000${n}`;

function plant(): void {
  localDb("R-2655").psql(`
begin;
set local app.zoho_purchase_import = 'on';
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance)
select '${ACC}'::uuid, ${E2E_TENANT_SQL}, 'SCN Zoho HDFC', 'HDFC', 'current', 0
on conflict (id) do nothing;
insert into public.zoho_fy_import_batches (id, tenant_id, kind, fy)
select '${BATCH}'::uuid, ${E2E_TENANT_SQL}, 'expenses', '2026-27'
on conflict (id) do nothing;
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, bill_no,
                             paid, paid_date, payment_method, bank_account_id, zoho_doc_id, zoho_leg, purchase_import_batch_id)
select v.id, ${E2E_TENANT_SQL}, v.cat, 'SCN Zoho Vendor', v.d::date, v.amt, 0, 'none', v.bill,
       true, v.d::date, 'bank', '${ACC}'::uuid, v.zdoc, v.leg, '${BATCH}'::uuid
  from (values
    ('EXP-Z-SCN2655-A-1', 'Office Supplies', '2026-11-02', 2655, 'SCN-Z-A', 'expenses:SCN2655A', 1),
    ('EXP-Z-SCN2655-A-2', 'Software',        '2026-11-02', 1345, 'SCN-Z-A', 'expenses:SCN2655A', 2),
    ('EXP-Z-SCN2655-B-1', 'Office Supplies', '2026-11-03', 7655, 'SCN-Z-B', 'expenses:SCN2655B', 1),
    ('EXP-Z-SCN2655-C-1', 'Office Supplies', '2026-11-05', 1655, 'SCN-Z-C', 'expenses:SCN2655C', 1)) v(id, cat, d, amt, bill, zdoc, leg)
on conflict (id) do nothing;
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source)
select v.id::uuid, ${E2E_TENANT_SQL}, '${ACC}'::uuid, v.d::date, v.descr, v.dr, 0, 'manual'
  from (values
    ('${T(1)}', '2026-11-04', 'POS SCN ZOHO AMZN', 4000),
    ('${T(2)}', '2026-11-05', 'POS SCN ZOHO TWIN ONE', 1655),
    ('${T(3)}', '2026-11-06', 'POS SCN ZOHO TWIN TWO', 1655)) v(id, d, descr, dr)
on conflict (id) do nothing;
commit;
`);
}

/** The button shows once the accounts and the role have loaded (owner / accountant). */
async function openMatches(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: "Match Zoho expenses" });
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  await expect(page.getByRole("dialog", { name: "Match Zoho expenses to bank lines" })).toBeVisible({ timeout: 60_000 });
}

test.describe("R-2655 — Match Zoho expenses to bank lines (preview)", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: Banking → Match Zoho expenses → SCN-Z-A (2 parts, ₹4,000) is a clean match with its debit and the reason", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/banking");
    await openMatches(page);
    await expect(page.getByText(/\d+ clean match(es)? · \d+ needs? a look/)).toBeVisible({ timeout: 60_000 });
    const clean = page.getByRole("region", { name: "Clean matches" });
    const row = await onlyOne(clean.getByRole("row").filter({ hasText: "SCN Zoho Vendor · SCN-Z-A" }), "the SCN-Z-A clean match");
    await expect(row).toContainText("₹4,000");
    await expect(row).toContainText("SCN Zoho HDFC · 2 parts");
    await expect(row).toContainText("POS SCN ZOHO AMZN");
    await expect(row).toContainText("the only open debit and the only Zoho document that fit");
    await expect(clean).not.toContainText("SCN-Z-B");
    await expect(clean).not.toContainText("SCN-Z-C");
  });

  test("Step 2: the same sheet → SCN-Z-B 'No bank line', SCN-Z-C 'More than one match' (both debits listed); no Book button", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/banking");
    await openMatches(page);
    const look = page.getByRole("region", { name: "Need a look" });
    const b = await onlyOne(look.getByRole("row").filter({ hasText: "SCN Zoho Vendor · SCN-Z-B" }), "the SCN-Z-B row");
    await expect(b).toContainText("No bank line");
    await expect(b).toContainText("₹7,655");
    await expect(b).toContainText("No open debit of this amount within 7 days");
    const c = look.getByRole("row").filter({ hasText: "SCN Zoho Vendor · SCN-Z-C" });
    await expect(c).toHaveCount(2);
    await expect(c.first()).toContainText("More than one match");
    await expect(look).toContainText("POS SCN ZOHO TWIN ONE");
    await expect(look).toContainText("POS SCN ZOHO TWIN TWO");
    // preview only: nothing on the sheet books anything
    await expect(page.getByRole("dialog").getByRole("button", { name: /book|undo/i })).toHaveCount(0);
  });

  test("Step 3: Open line on SCN-Z-A → the account page opens on that debit", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/banking");
    await openMatches(page);
    const link = page.getByRole("link", { name: "Open the bank line for SCN Zoho Vendor · SCN-Z-A" });
    await expect(link).toBeVisible({ timeout: 60_000 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/accounting/banking/${ACC}\\?txn=${T(1)}`), { timeout: 60_000 });
    await expect(page.getByText("POS SCN ZOHO AMZN").first()).toBeVisible({ timeout: 60_000 });
  });

  test("Step 4: Manager login → Banking has no Match Zoho expenses button", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "manager");
    await openAppPage(page, "/accounting/banking", /Banking/);
    await expect(page.getByRole("button", { name: "Category rules" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Match Zoho expenses" })).toHaveCount(0);
  });
});
