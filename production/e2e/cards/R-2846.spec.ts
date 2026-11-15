/* R-2846 card test — Record payment on a part payment request (advance proforma) says it is the
   ADVANCE for its month / period and that the tax invoice is raised on confirm; a normal quote's
   sheet is unchanged; a part request past its pay-by date reads "Pay-by date passed — still
   payable", not "Expired". Read-only: it opens the sheet and closes it, nothing is saved.
   Run: node scripts/ops/card-tests.mjs R-2846 (localhost only). */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const db = () => localDb("R-2846");

/** An unpaid advance request of E2E Test Co ("Advance payment for month N · …"); pastDue = its
 *  pay-by date (subscription_billings due_on, else bill_on — use-part-due.ts) is before today. */
function partRequestId(pastDue = false): string {
  return db().one(`select q.id from public.quotes q
    join public.subscription_billings b on b.id = q.subscription_billing_id
    where q.tenant_id = ${E2E_TENANT_SQL}
    and q.invoice_id is null and q.cancelled_at is null
    and q.payment_status = 'awaiting' and q.status in ('sent','viewed','accepted')
    and jsonb_array_length(q.line_items) = 1
    and q.line_items->0->>'name' like 'Advance payment for %'
    ${pastDue ? "and coalesce(b.due_on, b.bill_on) < (now() at time zone 'Asia/Kolkata')::date" : ""}
    order by q.created_at desc limit 1`);
}

/** An unpaid ordinary quote of E2E Test Co. */
function normalQuoteId(): string {
  return db().one(`select id from public.quotes where tenant_id = ${E2E_TENANT_SQL}
    and subscription_billing_id is null and cancelled_part_billing_id is null and invoice_id is null
    and payment_status = 'awaiting' and status = 'accepted' and superseded_by is null
    order by created_at desc limit 1`);
}

test.describe("R-2846 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test("Step 1: advance request → Record payment says 'Record advance payment', month · period, Part x of y, invoice on confirm, 'Advance due'", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    if (!CARD_TESTS_ON) return;
    const id = partRequestId();
    test.skip(!id, "No unpaid 'Advance payment for …' request in E2E Test Co on this machine.");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${id}`);
    const btn = page.getByRole("button", { name: /^Record payment/ }).first();
    await expect(btn).toBeVisible({ timeout: 60_000 });
    await btn.click();
    const sheet = page.getByRole("dialog", { name: "Record advance payment" });
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByText(/^Advance for .+ \(Part \d+( of \d+)?\) from .+\. The tax invoice is raised when you confirm the full advance\.$/)).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByText("Advance due", { exact: true })).toBeVisible();
    await expect(sheet.getByText(/Log a payment against quote|Expected this payment|Quote total/)).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: a request past its pay-by date reads 'Pay-by date passed — still payable', never 'Expired'", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    if (!CARD_TESTS_ON) return;
    const id = partRequestId(true);
    test.skip(!id, "No unpaid advance request past its pay-by date in E2E Test Co on this machine.");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${id}`);
    const main = page.getByRole("main");
    await expect(main.getByText("Payment request", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText("Pay-by date passed — still payable", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText("Expired", { exact: true })).toHaveCount(0);
    await page.context().close();
  });

  test("Step 3: a normal quote's Record payment is unchanged (Quote total / Expected this payment)", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    if (!CARD_TESTS_ON) return;
    const id = normalQuoteId();
    test.skip(!id, "No unpaid accepted quote in E2E Test Co on this machine.");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${id}`);
    const btn = page.getByRole("button", { name: /^Record payment/ }).first();
    await expect(btn).toBeVisible({ timeout: 60_000 });
    await btn.click();
    const sheet = page.getByRole("dialog", { name: /Record payment received|Record additional payment/ });
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByText(/Log a payment against quote/)).toBeVisible();
    await expect(sheet.getByText("Advance due", { exact: true })).toHaveCount(0);
    await page.context().close();
  });
});
