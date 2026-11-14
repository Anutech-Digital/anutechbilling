/**
 * Card test — R-2818 "Renewals: 'Previous term unpaid' = real invoices minus payments, same number
 * as the customer page" (renewals 12-question audit, 14 Nov 2026).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2818`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * three customers, each with one subscription renewing in 12 days (tab 8–30) — the audit's three rows:
 *   · K "CT R2818 Kochi Co" — ₹25,488 on subscriptions.outstanding_amount, no quote, no invoice, and a
 *     DRAFT renewal quote of ₹25,488 (as SCN Kochi Hosting): customer page All clear → no previous-term debt;
 *   · V "CT R2818 Credit Co" — its quote Q-CT2818-V (₹38,232) accepted on credit, ₹10,000 paid, never
 *     invoiced (as T-V4-21Oct): the customer page says ₹28,232 → the row says the same, against that quote;
 *   · U "CT R2818 USD Co" — invoice INV-CT2818-U $1,200 with $500 (₹42,000) on the invoice and no receipt
 *     row (as CT R2737 USD Plan): the drawer lists that $500, never "No payment recorded".
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST_K = "c2818000-0000-4000-8000-000000000001";
const CUST_V = "c2818000-0000-4000-8000-000000000002";
const CUST_U = "c2818000-0000-4000-8000-000000000003";
const SUB_K = "c2818000-0000-4000-8000-000000000021";
const SUB_V = "c2818000-0000-4000-8000-000000000022";
const SUB_U = "c2818000-0000-4000-8000-000000000023";
const PAY_V = "c2818000-0000-4000-8000-000000000041";
const CUSTS = [CUST_K, CUST_V, CUST_U];
const SUBS = [SUB_K, SUB_V, SUB_U];
const QUOTES = ["Q-CT2818-K", "Q-CT2818-V", "Q-CT2818-U"];
const INVOICES = ["INV-CT2818-U"];
const db = () => localDb("R-2818");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2818", {
    invoiceIds: INVOICES,
    before: `delete from public.payments where id = '${PAY_V}' and tenant_id = ${T};
             update public.quotes set invoice_id = null where id in (${inList(QUOTES)}) and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in (${inList(SUBS)}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${inList(QUOTES)}) and tenant_id = ${T};
            delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
            delete from public.customers where id in (${inList(CUSTS)}) and tenant_id = ${T};`,
  });
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country) values
      ('${CUST_K}', ${T}, 'CT R2818 Kochi Co', 'ct2818k@example.test', '32', 'India'),
      ('${CUST_V}', ${T}, 'CT R2818 Credit Co', 'ct2818v@example.test', '07', 'India'),
      ('${CUST_U}', ${T}, 'CT R2818 USD Co', 'ct2818u@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount) values
      ('${SUB_K}', ${T}, '${CUST_K}', 'CT R2818 Kochi Co', 'CT R2818 Kochi Plan', 'google', 20, 1800, 12, 'yearly',
       public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 25488),
      ('${SUB_V}', ${T}, '${CUST_V}', 'CT R2818 Credit Co', 'CT R2818 Credit Plan', 'google', 10, 2700, 12, 'yearly',
       public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 28232),
      ('${SUB_U}', ${T}, '${CUST_U}', 'CT R2818 USD Co', 'CT R2818 USD Plan', 'google', 5, 7000, 12, 'yearly',
       public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, 0);
    -- K: a DRAFT renewal quote of the same ₹25,488 — never "owed"
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, renewal_subscription_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2818-K', ${T}, '${CUST_K}', 'CT R2818 Kochi Co', 'draft', 'awaiting', '${SUB_K}', public.ist_today() - 1, 25488, 21600, 18, '[]');
    update public.subscriptions set renewal_quote_id = 'Q-CT2818-K' where id = '${SUB_K}';
    -- V: accepted on credit, ₹10,000 of ₹38,232 paid, no invoice
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2818-V', ${T}, '${CUST_V}', 'CT R2818 Credit Co', 'accepted', 'partial', public.ist_today() - 354, 38232, 32400, 18, '[]');
    update public.subscriptions set quote_id = 'Q-CT2818-V' where id = '${SUB_V}';
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes)
      values ('${PAY_V}', ${T}, 'Q-CT2818-V', '${CUST_V}', 10000, 'upi', 'CTUPI2818', 'received', now() - interval '350 days', 'Card test R-2818 — local only');
    -- U: USD invoice, $500 (₹42,000 at 84) on the invoice, no receipt row
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2818-U', ${T}, '${CUST_U}', 'CT R2818 USD Co', 'accepted', 'invoiced', public.ist_today() - 20, 100800, 100800, 0, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date, currency, fx_rate)
      values ('INV-CT2818-U', ${T}, '${CUST_U}', 'CT R2818 USD Co', 'Q-CT2818-U', 'pending', 100800, 0, 42000, public.ist_today() - 20, public.ist_today() + 10, 'USD', 84);
    update public.quotes set invoice_id = 'INV-CT2818-U' where id = 'Q-CT2818-U';
    update public.subscriptions set quote_id = 'Q-CT2818-U' where id = '${SUB_U}';
    commit;`);
}

async function rowOf(page: Page, width: number, plan: string) {
  await page.setViewportSize({ width, height: 900 });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  await expect(r.getByTestId("stage-chip")).toBeVisible({ timeout: 60_000 });   // documents read — the stage is decided
  return r;
}

async function customerOutstanding(page: Page, customerId: string): Promise<string> {
  await openAppPage(page, `/customers/${customerId}`);
  const label = page.getByText("Outstanding", { exact: true }).first();
  await expect(label).toBeVisible({ timeout: 60_000 });
  const value = label.locator("xpath=following-sibling::div[1]");
  await expect(value).not.toHaveText("—", { timeout: 60_000 });
  return (await value.innerText()).trim();
}

async function openFollowup(page: Page, plan: string) {
  /* the row's documents first (its stage decided), then its drawer — as the owner does */
  const r = await rowOf(page, 1280, plan);
  await r.getByTestId("renewal-open-drawer").click();
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByTestId("stage-actions").first()).toBeVisible({ timeout: 60_000 });   // the next step is decided
  const primary = drawer.getByTestId("stage-primary").first();
  if (/follow/i.test((await primary.count()) ? await primary.innerText() : "")) await primary.click();
  else {
    const more = drawer.getByTestId("stage-more").first();
    await expect(more).toBeVisible({ timeout: 60_000 });
    await more.click();
    await page.getByRole("menuitem", { name: /Follow[- ]?up/i }).click();
  }
  const dlg = page.getByRole("dialog").filter({ hasText: "Renewal follow-up" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  return dlg;
}

test.describe("R-2818 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  for (const width of [1276, 1280]) {
    test(`Step 1${width === 1276 ? "" : "b"}: at ${width}px a balance on no quote / invoice (+ a draft quote) shows no 'Previous term … unpaid' — customer page All clear`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      const r = await rowOf(page, width, "CT R2818 Kochi Plan");
      await expect(r.locator("[data-flag='priorTermUnpaid']")).toHaveCount(0);
      await expect(r.getByText(/Previous term/)).toHaveCount(0);
      await expect(r.getByTestId("renewal-prior-due-no-invoice")).toHaveCount(0);
      if (width === 1280) expect(await customerOutstanding(page, CUST_K)).toBe("All clear");
    });
  }

  for (const width of [1276, 1280]) {
    test(`Step 2${width === 1276 ? "" : "b"}: at ${width}px a quote on credit, part paid, not invoiced → 'Previous term ₹28,232' naming that quote — the customer page says ₹28,232 too`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      const r = await rowOf(page, width, "CT R2818 Credit Plan");
      await expect(r.locator("[data-flag='priorTermUnpaid']")).toHaveAttribute("aria-label", /Previous term ₹28,232 still unpaid/, { timeout: 60_000 });
      await expect(r.getByTestId("renewal-prior-due-no-invoice").first()).toContainText("Q-CT2818-V not invoiced yet");
      await expect(r.getByText(/Balance on the subscription/)).toHaveCount(0);
      if (width === 1280) expect(await customerOutstanding(page, CUST_V)).toBe("₹28,232");
    });
  }

  test("Step 3: the USD invoice's $500 is listed in the drawer's Payments (never 'No payment recorded')", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAppPage(page, `/renewals?bucket=d30&sub=${SUB_U}`);
    const drawer = page.getByTestId("renewal-drawer");
    await expect(drawer).toBeVisible({ timeout: 60_000 });
    const pay = drawer.getByTestId("renewal-drawer-payment");
    await expect(pay).toHaveCount(1, { timeout: 60_000 });
    await expect(pay).toContainText("Paid on the invoice — no receipt in the app");
    await expect(pay).toContainText("INV-CT2818-U");
    await expect(pay).toContainText("$500");
    await expect(drawer.getByText(/No payment recorded/)).toHaveCount(0);
  });

  test("Step 3b: the follow-up dialog's 'Still owes' is what the documents owe — none for the Kochi shape, ₹28,232 for the credit one", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const k = await openFollowup(page, "CT R2818 Kochi Plan");
    await expect(k).not.toContainText("Still owes");
    await page.keyboard.press("Escape");
    const v = await openFollowup(page, "CT R2818 Credit Plan");
    await expect(v).toContainText("Still owes ₹28,232");
  });
});
