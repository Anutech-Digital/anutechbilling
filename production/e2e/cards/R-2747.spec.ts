/**
 * Card test — R-2747 "Renewals: invoice status cut to 'Unp…'/'Ove…' in the wide table, and
 * 'Previous term unpaid' rows show no invoice line" (owner's Chrome check of R-2737, 13 Nov 2026).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2747`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2747 Renewals Pvt Ltd", every plan's renewal date 5 days ago (Overdue tab):
 *   · A "CT R2747 Overdue Plan" — invoice INV-CT2747-A ₹40,000, ₹6,768 in, due 10 days ago →
 *     "Overdue 10d · ₹33,232 due" (the owner's T-M3-19Oct text) — must show IN FULL at 1280 and 1568;
 *   · B "CT R2747 Prior Due Plan" — ₹25,488 on subscriptions.outstanding_amount, no quote, no invoice
 *     (as SCN Kochi Hosting in scenario money-owed-archived) → "Previous term ₹25,488 still unpaid"
 *     + "Balance on the subscription, no invoice — not in the customer's statement";
 *   · C "CT R2747 Cancelled Plan" — its only invoice voided → grey "Cancelled".
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2747000-0000-4000-8000-000000000001";
const SUB_A = "c2747000-0000-4000-8000-000000000021";
const SUB_B = "c2747000-0000-4000-8000-000000000022";
const SUB_C = "c2747000-0000-4000-8000-000000000023";
const SUBS = [SUB_A, SUB_B, SUB_C];
const NAME = "CT R2747 Renewals Pvt Ltd";
const QUOTES = ["Q-CT2747-A", "Q-CT2747-C"];
const INVOICES = ["INV-CT2747-A", "INV-CT2747-C"];
const db = () => localDb("R-2747");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2747", {
    invoiceIds: INVOICES,
    before: `update public.quotes set invoice_id = null where id in (${inList(QUOTES)}) and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in (${inList(SUBS)}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${inList(QUOTES)}) and tenant_id = ${T};
            delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2747@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', 'CT R2747 Overdue Plan', 'google', 10, 1000, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 0),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', 'CT R2747 Prior Due Plan', 'google', 20, 1800, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 25488),
             ('${SUB_C}', ${T}, '${CUST}', '${NAME}', 'CT R2747 Cancelled Plan', 'google', 2, 200, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 0);
    -- A: invoice ₹40,000, ₹6,768 in, due 10 days ago
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2747-A', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 40, 40000, 33898.31, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2747-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2747-A', 'pending', 40000, 6101.69, 6768, public.ist_today() - 40, public.ist_today() - 10);
    update public.quotes set invoice_id = 'INV-CT2747-A' where id = 'Q-CT2747-A';
    update public.subscriptions set quote_id = 'Q-CT2747-A' where id = '${SUB_A}';
    -- C: its only invoice voided
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2747-C', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 30, 2360, 2000, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2747-C', ${T}, '${CUST}', '${NAME}', 'Q-CT2747-C', 'void', 2360, 360, 0, public.ist_today() - 30);
    update public.quotes set invoice_id = 'INV-CT2747-C' where id = 'Q-CT2747-C';
    update public.subscriptions set quote_id = 'Q-CT2747-C' where id = '${SUB_C}';
    commit;`);
}

async function rowOf(page: Page, plan: string): Promise<Locator> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

/** Every line of the docs block inside its table cell, none cut (no ellipsis, nothing hidden), page not wider than the window. */
async function fitsUncut(docs: Locator) {
  return docs.evaluate((el) => {
    const td = el.closest("td")!;
    const cell = td.getBoundingClientRect();
    const ps = [...el.querySelectorAll("p")];
    return {
      lines: ps.length > 0,
      insideCell: ps.every((p) => p.getBoundingClientRect().right <= cell.right + 0.5),
      noEllipsis: ps.every((p) => getComputedStyle(p).textOverflow !== "ellipsis"),
      nothingHidden: ps.every((p) => p.scrollWidth <= p.clientWidth + 1),
      pageFits: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
}

test.describe("R-2747 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  for (const width of [1568, 1280]) {
    test(`Step ${width === 1568 ? 2 : "2b"}: at ${width}px the table row shows the full 'Invoice INV-… · Overdue 10d · ₹33,232 due' and its date — wrapped, never cut`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      await page.setViewportSize({ width, height: 900 });
      const r = await rowOf(page, "CT R2747 Overdue Plan");
      const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
      await expect(await onlyOne(docs.getByRole("link", { name: "INV-CT2747-A" }), "invoice link")).toBeVisible({ timeout: 60_000 });
      const status = docs.getByTestId("renewal-last-invoice-status");
      await expect(status).toHaveText("Overdue 10d · ₹33,232 due");
      await expect(status).toBeVisible();
      await expect(docs.getByTestId("renewal-last-invoice-period")).toHaveText(/^dated \d{1,2} [A-Z][a-z]{2} \d{4}$/);
      expect(await fitsUncut(docs)).toEqual({ lines: true, insideCell: true, noEllipsis: true, nothingHidden: true, pageFits: true });
    });
  }

  for (const width of [1568, 1280]) {
    test(`Step 3${width === 1568 ? "" : "b"}: at ${width}px a 'Previous term ₹25,488 still unpaid' row with no invoice says why`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      await page.setViewportSize({ width, height: 900 });
      const r = await rowOf(page, "CT R2747 Prior Due Plan");
      await expect(r.getByText("Previous term ₹25,488 still unpaid")).toBeVisible({ timeout: 60_000 });
      const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
      await expect(docs.getByTestId("renewal-prior-due-no-invoice")).toHaveText("Balance on the subscription, no invoice — not in the customer's statement", { timeout: 60_000 });
      await expect(docs.getByTestId("renewal-last-invoice-status")).toHaveCount(0);
      expect(await fitsUncut(docs)).toEqual({ lines: true, insideCell: true, noEllipsis: true, nothingHidden: true, pageFits: true });
    });
  }

  test("Step 4: a cancelled latest invoice shows grey 'Cancelled' (not red, not 'Unpaid')", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2747 Cancelled Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(await onlyOne(docs.getByRole("link", { name: "INV-CT2747-C" }), "void invoice link")).toBeVisible({ timeout: 60_000 });
    const status = docs.getByTestId("renewal-last-invoice-status");
    await expect(status).toHaveText("Cancelled");
    await expect(status).toHaveClass(/text-ink-3/);
    await expect(status).not.toHaveClass(/rose/);
  });
});
