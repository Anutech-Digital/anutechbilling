/**
 * Card test — R-2642 "Part / cron invoices: paid_date = the receipt day" (R-2631 follow-up).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2642` (localhost must run code with migration 20261109220936).
 *
 * Data (planted here, local docker DB only): SCN Part Paid Buyer (Delhi), accepted quarterly sale quote
 * Q-SCN-PPR-1 (₹4,000 + 18% a year, billed in quarters) with its subscription and Q1 part (bill date 1 Sep 2026,
 * ₹1,000 + 18% = ₹1,180), paid ₹1,180 on 5 Sep 2026, no invoice yet. E2E Test Co's "GST returns filed up to" is
 * cleared before step 1 (the owner sets it in step 1) and put back after the last step; the planted rows are
 * removed after the last step.
 */
import { expect, test } from "@playwright/test";
import {
  CARD_TESTS_ON, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, openCollapsedPanel, pageAs, setGstFiledThrough,
} from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2642000-0000-4000-8000-000000000001";
const SUB_ID = "c2642000-0000-4000-8000-000000000002";
const PART_ID = "c2642000-0000-4000-8000-000000000003";
const PAYMENT_ID = "c2642000-0000-4000-8000-000000000011";
const CUSTOMER = "SCN Part Paid Buyer";
const QUOTE = "Q-SCN-PPR-1";

/** The local docker DB, guarded (card-steps localDb, R-2666). */
const psql = (sql: string): string[] => localDb("R-2642").psql(sql);

/** Removes this test's rows (a part invoice it raised goes too — a local test invoice). That invoice is PAID, so a
    plain delete is refused — card-steps localCleanupDeleteIssuedInvoice (app.invoice_amend_reason, transaction-local,
    E2E Test Co + the part's own invoice / this quote's invoices only; local docker DB only). */
function unplant(): void {
  const partInvoiceIds = psql(`select invoice_id from public.subscription_billings where id = '${PART_ID}' and invoice_id is not null;`);
  localCleanupDeleteIssuedInvoice(localDb("R-2642"), "R-2642", {
    invoiceIds: partInvoiceIds,
    quoteIds: [QUOTE],
    before: `update public.subscription_billings set invoice_id = null where id = '${PART_ID}';`,
    after: `delete from public.subscription_billings where subscription_id = '${SUB_ID}';
delete from public.payments where id = '${PAYMENT_ID}';
delete from public.subscriptions where id = '${SUB_ID}';
delete from public.quotes where id = '${QUOTE}';
delete from public.customers where id = '${CUSTOMER_ID}';`,
  });
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', '07AAHCP2642K1Z5', 'Saket', 'New Delhi', 'Delhi', '07', '110017', 'India', 'business',
       'R-2642 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           payment_amount, payment_received_at, created_date, billing_cycle, currency, line_items, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 4720, 4000, 18, 'accepted', 'partial',
       1180, '2026-09-05 11:00:00+05:30', '2026-08-25', 'quarterly', 'INR',
       '[{"name":"Google Workspace Business Starter","qty":1,"rate":4000,"commitment":"annual_quarterly"}]'::jsonb, 'R-2642 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle, quote_id, start_date, status)
select '${SUB_ID}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'Google Workspace Business Starter', 'google'::vendor, 1, 333,
       'quarterly'::billing_cycle, '${QUOTE}', '2026-09-01', 'active'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
select '${PART_ID}', t.id, '${SUB_ID}', '2026-09-01', 1, '2026-09-01', '2026-09-01', '2026-11-30', 1000, 18
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at)
select '${PAYMENT_ID}', t.id, '${QUOTE}', '${CUSTOMER_ID}', 1180, 'bank_transfer', 'R2642-CARD-SEP', 'received', '2026-09-05 11:00:00+05:30'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
commit;`);
}

/** The owner's setting before this test, put back after it. */
let savedSetting: string | null = null;
function readSetting(): string | null {
  const v = (psql(`select coalesce(gst_filed_through::text, '') from public.tenants where email = '${E2E_TENANT_EMAIL}';`)[0] ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function writeSetting(v: string | null): void {
  psql(`update public.tenants set gst_filed_through = ${v ? `'${v}'` : "null"} where email = '${E2E_TENANT_EMAIL}';`);
}

/** "invoice_date|paid_date|status" of the Q1 part's invoice; "" while there is none. */
function partInvoice(): string {
  return (psql(`select coalesce((select i.invoice_date::text || '|' || coalesce(i.paid_date::text, '') || '|' || i.status::text
    from public.invoices i join public.subscription_billings b on b.invoice_id = i.id where b.id = '${PART_ID}'), '');`)[0] ?? "").trim();
}

test.describe("R-2642 — a part invoice is paid on the day the money came in, not the shifted invoice date", () => {
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
      /* Wait for the saved setting to load (cleared in beforeAll) before typing — on a cold page the form
         re-renders with the loaded value and wipes what was typed, leaving Save disabled (first run, 10 Nov). */
      await setGstFiledThrough(page, "2026-09", "September 2026");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Invoices → Pending GST invoice generation → SCN Part Paid Buyer → Generate invoice for Q1 ₹1,180 → invoice dated 1 Oct 2026", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/invoices");
      // the "Pending GST invoice generation" panel opens collapsed
      const row = page.getByRole("row").filter({ hasText: CUSTOMER });
      await openCollapsedPanel(page, /Pending GST invoice generation/, row);
      await row.getByRole("button", { name: /Generate invoice for Q1/ }).first().click({ timeout: 60_000 });
      await expect.poll(() => partInvoice().split("|")[0], { timeout: 120_000, message: "Q1 invoice dated 1 Oct 2026" }).toBe("2026-10-01");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: that invoice is Paid, paid on 5 Sep 2026 (the day the money came), not 1 Oct", async () => {
    expect(partInvoice()).toBe("2026-10-01|2026-09-05|paid");
  });
});
