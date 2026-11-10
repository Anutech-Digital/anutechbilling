/**
 * Card test — R-2631 "New invoices on non-bank paths must know about GST-filed months" (owner's option A:
 * the money is always recorded; a NEW tax invoice is dated on the first open day, never in a filed month).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2631`.
 *
 * Data (planted here, local docker DB only): SCN First Open Buyer (Delhi), accepted quote Q-SCN-GFO-1 ₹5,900
 * (₹5,000 + 18%), no invoice, with a ₹5,900 receipt received 18 Sep 2026. E2E Test Co's "GST returns filed up
 * to" is cleared before step 1 (the owner sets it in step 1) and put back to what it was after the last step; the
 * planted rows are removed after the last step.
 */
import { expect, test } from "@playwright/test";
import {
  CARD_TESTS_ON, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs, setGstFiledThrough,
} from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2631000-0000-4000-8000-000000000001";
const PAYMENT_ID = "c2631000-0000-4000-8000-000000000011";
const CUSTOMER = "SCN First Open Buyer";
const QUOTE = "Q-SCN-GFO-1";

/** The local docker DB, guarded (card-steps localDb, R-2666). */
const psql = (sql: string): string[] => localDb("R-2631").psql(sql);

/** Removes this test's rows (an invoice it raised goes too — it is a local test invoice). Step 3's invoice is
    PAID (the planted receipt settles it), so a plain delete is refused — card-steps localCleanupDeleteIssuedInvoice
    (app.invoice_amend_reason, transaction-local, E2E Test Co + this quote only; local docker DB only). */
function unplant(): void {
  localCleanupDeleteIssuedInvoice(localDb("R-2631"), "R-2631", {
    quoteIds: [QUOTE],
    before: `update public.quotes set invoice_id = null, payment_status = 'awaiting' where id = '${QUOTE}';`,
    after: `delete from public.payments where id = '${PAYMENT_ID}';
delete from public.quotes where id = '${QUOTE}';
delete from public.customers where id = '${CUSTOMER_ID}';`,
  });
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', '07AAHCF2631K1Z5', 'Saket', 'New Delhi', 'Delhi', '07', '110017', 'India', 'business',
       'R-2631 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct, status,
                           payment_status, created_date, billing_cycle, currency, line_items, is_one_off, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Workspace setup', 1, 5900, 5000, 18, 0, 'accepted', 'awaiting',
       '2026-09-05', 'yearly', 'INR',
       '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace setup (one time)", "rate": 5000, "one_time": true}]'::jsonb,
       true, 'R-2631 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at)
select '${PAYMENT_ID}', t.id, '${QUOTE}', '${CUSTOMER_ID}', 5900, 'bank_transfer', 'R2631-CARD-SEP', 'received', '2026-09-18 11:00:00+05:30'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
commit;`);
}

/** The owner's setting before this test, put back after it (postgres session — the guard trigger refuses only
    request logins). */
let savedSetting: string | null = null;
function readSetting(): string | null {
  const v = (psql(`select coalesce(gst_filed_through::text, '') from public.tenants where email = '${E2E_TENANT_EMAIL}';`)[0] ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function writeSetting(v: string | null): void {
  psql(`update public.tenants set gst_filed_through = ${v ? `'${v}'` : "null"} where email = '${E2E_TENANT_EMAIL}';`);
}

function invoiceOfQuote(): string {
  return (psql(`select coalesce(string_agg(i.invoice_date::text, ','), '') from public.invoices i where i.quote_id = '${QUOTE}';`)[0] ?? "").trim();
}

function receiptDay(): string {
  return (psql(`select ((received_at at time zone 'Asia/Kolkata')::date)::text from public.payments where id = '${PAYMENT_ID}';`)[0] ?? "").trim();
}

test.describe("R-2631 — a new invoice for money of a GST-filed month is dated on the first open day", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    savedSetting = readSetting();
    writeSetting(null);
    plant();
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON) return;
    writeSetting(savedSetting);
    unplant();
  });

  test("Step 1: Accounting → Overview → GST returns filed up to → September 2026 → Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await setGstFiledThrough(page, "2026-09", "September 2026"); // waits for the stored month before typing (R-2666)
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Quote Q-SCN-GFO-1 (paid 18 Sep) → Generate GST Invoice → the confirm says Dated 1 Oct 2026 — the first open day", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(/Dated 1 Oct 2026 — the first open day/, { timeout: 60_000 });
      await expect(dialog).not.toContainText("18 Sep 2026");
      await expect(dialog).not.toContainText("(today)");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: issue it → one invoice dated 1 Oct 2026 (not in September); the receipt stays on 18 Sep", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      await page.locator("main").getByRole("button", { name: /Generate GST Invoice|Invoice now/ }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(/Dated 1 Oct 2026/, { timeout: 60_000 });
      await dialog.getByRole("button", { name: "Issue invoice" }).click();
      await expect.poll(() => invoiceOfQuote(), { timeout: 120_000, message: "one invoice on the quote, dated 1 Oct 2026" }).toBe("2026-10-01");
      expect(receiptDay()).toBe("2026-09-18");
    } finally {
      await page.context().close();
    }
  });
});
