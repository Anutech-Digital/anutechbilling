/**
 * Card test — R-2745 "Razorpay settlement fee + its input GST are dated on the first open (not GST-filed) day" (R-2550).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2745` (after `npm run localhost:update` brings the R-2745 migration to the
 * local DB — the planted booking goes through reconcile_razorpay_settlement itself).
 *
 * Data (E2E Test Co + the local docker DB only; taken out again in afterAll): customer "SCN Razorpay Fee Buyer", quote
 * Q-SCN-RZF-1 (₹1,180) paid by Razorpay (pay_CT2745), and the settlement bank line "… RAZORPAY PAYMENTS … CT2745" of
 * ₹1,156 on 20 Oct 2025 in the E2E bank account. With "GST returns filed up to" = October 2025 the settlement is booked
 * (as the E2E owner, no Razorpay call — the settlement facts are given to the RPC the way the Fetch settlement screen
 * gives them): the line is reconciled on 20 Oct 2025 while the ₹24 fee expense (GST ₹4) is dated 1 Nov 2025.
 * The owner's setting is saved first and put back in afterAll.
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";
import { E2E_BANK_NAME } from "../fixtures/e2e-roles.mjs";

const CARD = "R-2745";
const TXN = "c2745000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "c2745000-0000-4000-8000-000000000002";
const PAYMENT_ID = "c2745000-0000-4000-8000-000000000003";
const QUOTE = "Q-SCN-RZF-1";
const CUSTOMER = "SCN Razorpay Fee Buyer";
const SETL = "setl_CT2745";
const NARR = "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-CT2745";
const EXPENSE = `EXP-RZPFEE-STL-${SETL}`;

let savedFiledThrough: string | null = null;

/** The E2E owner's JWT claims for a psql call that must run as the owner (the RPC's tenant / role gate). */
function ownerClaims(): string {
  const db = localDb(CARD);
  const uid = db.one(`select u.id from public.users u where u.tenant_id = ${E2E_TENANT_SQL} and u.role = 'owner' order by u.created_at limit 1;`);
  if (!/^[0-9a-f-]{36}$/.test(uid)) throw new Error("E2E Test Co has no owner user");
  return `{"sub":"${uid}","role":"authenticated"}`;
}

function account(): string {
  const id = localDb(CARD).one(`select ba.id from public.bank_accounts ba where ba.tenant_id = ${E2E_TENANT_SQL} and ba.name = '${E2E_BANK_NAME}' order by ba.created_at limit 1;`);
  if (!id) throw new Error(`E2E Test Co has no bank account "${E2E_BANK_NAME}"`);
  return id;
}

function unplant(): void {
  const db = localDb(CARD);
  db.psql(`
begin;
-- a direct DB session (not a request login): the R-2745 filed-day check does not apply, the un-match removes the
-- settlement rows + fee expense (R-2099 trigger) and frees the receipt (R-2098 trigger)
update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '${TXN}' and matched_to_type is not null;
delete from public.expenses where id = '${EXPENSE}' and tenant_id = ${E2E_TENANT_SQL};
delete from public.bank_transactions where id = '${TXN}';
delete from public.payments where id = '${PAYMENT_ID}' and tenant_id = ${E2E_TENANT_SQL};
delete from public.quotes where id = '${QUOTE}' and tenant_id = ${E2E_TENANT_SQL};
delete from public.customers where id = '${CUSTOMER_ID}' and tenant_id = ${E2E_TENANT_SQL};
commit;`);
}

function plant(): void {
  const db = localDb(CARD);
  unplant();
  const was = db.one(`select coalesce(gst_filed_through::text, '') from public.tenants where id = ${E2E_TENANT_SQL};`) || null;
  /* a killed earlier run may have left this test's own value behind — never save that as the one to put back */
  savedFiledThrough = was === "2025-10-31" || was === "2025-11-30" ? null : was;
  db.psql(`
begin;
insert into public.customers (id, tenant_id, name, gstin, address, city, state, state_code, pin_code, country, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', '07AAHCF2745K1Z5', 'Saket', 'New Delhi', 'Delhi', '07', '110017', 'India', 'business', 'R-2745 card test'
  from public.tenants t where t.id = ${E2E_TENANT_SQL};
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct, status,
                           payment_status, created_date, billing_cycle, currency, line_items, is_one_off, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Workspace setup', 1, 1180, 1000, 18, 0, 'accepted', 'received',
       '2025-10-10', 'yearly', 'INR',
       '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Workspace setup (one time)", "rate": 1000, "one_time": true}]'::jsonb,
       true, 'R-2745 card test'
  from public.tenants t where t.id = ${E2E_TENANT_SQL};
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at)
select '${PAYMENT_ID}', t.id, '${QUOTE}', '${CUSTOMER_ID}', 1180, 'razorpay', 'pay_CT2745', 'received', '2025-10-18 11:00:00+05:30'
  from public.tenants t where t.id = ${E2E_TENANT_SQL};
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source)
select '${TXN}', t.id, '${account()}', '2025-10-20', '${NARR}', 0, 1156, 'CT2745UTR', 'manual'
  from public.tenants t where t.id = ${E2E_TENANT_SQL};
update public.tenants set gst_filed_through = '2025-10-31' where id = ${E2E_TENANT_SQL};
commit;`);
  /* The booking itself, as the owner — exactly what "Reconcile settlement" sends (R-2099), no Razorpay call. */
  db.psql(`
begin;
select set_config('request.jwt.claims', '${ownerClaims()}', true);
set local role authenticated;
select public.reconcile_razorpay_settlement('${TXN}', jsonb_build_object('id', '${SETL}', 'utr', 'CT2745UTR', 'fee_paise', 2400, 'tax_paise', 400,
  'payments', jsonb_build_array(jsonb_build_object('rzp_id', 'pay_CT2745', 'amount_paise', 118000, 'payment_ids', jsonb_build_array('${PAYMENT_ID}'))),
  'refunds', '[]'::jsonb));
commit;`);
}

function restoreSetting(): void {
  const db = localDb(CARD);
  db.psql(`update public.tenants set gst_filed_through = ${savedFiledThrough ? `'${savedFiledThrough}'` : "null"} where id = ${E2E_TENANT_SQL};`);
}

test.describe.serial("R-2745 — Razorpay settlement fee on the first open day", () => {
  onlyInCardTests();
  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) { restoreSetting(); unplant(); } });

  test("Step 1: Owner → Accounting → Expenses (Nov 2025, search setl_CT2745) → 'Razorpay fee on settlement setl_CT2745' dated 1 Nov 2025, ₹24", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/accounting/expenses?from=2025-11-01&to=2025-11-30&q=${SETL}`);
    const row = await onlyOne(page.locator("main").getByRole("row").filter({ hasText: `Razorpay fee on settlement ${SETL}` }), "the fee expense row");
    await expect(row).toContainText(/\b1 Nov 2025/);
    await expect(row).not.toContainText("20 Oct 2025");
    /* the database says the same: first open day, notes say why, paid on the line's day */
    const db = localDb(CARD);
    expect(db.one(`select expense_date::text || '|' || paid_date::text || '|' || amount || '|' || gst_paid from public.expenses where id = '${EXPENSE}';`))
      .toBe("2025-11-01|2025-10-20|24|4");
    expect(db.one(`select notes from public.expenses where id = '${EXPENSE}';`)).toMatch(/first open day: GST returns are filed up to October 2025/);
  });

  test("Step 2: Banking → E2E bank → the 20 Oct 2025 ₹1,156 Razorpay line is reconciled on its own date", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/accounting/banking/${account()}?from=2025-10-01&to=2025-10-31&q=CT2745`);
    const row = await onlyOne(page.locator("main").getByRole("row").filter({ hasText: "CT2745" }), "the settlement bank line");
    await expect(row).toContainText("20 Oct 2025");
    /* a reconciled line shows its match type ("Payment") and an Un-reconcile button (an open line shows Match instead) */
    await expect(row.getByRole("button", { name: "Un-reconcile" })).toBeVisible();
    await expect(row).toContainText("Payment");
    expect(localDb(CARD).one(`select matched_to_type || '|' || txn_date::text from public.bank_transactions where id = '${TXN}';`)).toBe("payment|2025-10-20");
  });

  test("Step 3: GST for Nov 2025 is filed AFTER the booking → un-reconcile of that line is refused with the reason; the line stays reconciled and the fee expense stays", async () => {
    const db = localDb(CARD);
    /* the fee expense sits on 1 Nov 2025 (open when booked); now that month is filed too — its input credit is in a filed return */
    db.psql(`update public.tenants set gst_filed_through = '2025-11-30' where id = ${E2E_TENANT_SQL};`);
    let message = "";
    try {
      db.psql(`
begin;
select set_config('request.jwt.claims', '${ownerClaims()}', true);
set local role authenticated;
select public.unreconcile_bank_receipt('${TXN}', false);
commit;`);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/EXP-RZPFEE-STL-setl_CT2745/);
    expect(message).toMatch(/GST for that day is already filed/);
    expect(message).toMatch(/the line stays reconciled/);
    expect(db.one(`select matched_to_type from public.bank_transactions where id = '${TXN}';`)).toBe("payment");
    expect(db.one(`select count(*) from public.expenses where id = '${EXPENSE}';`)).toBe("1");
    expect(db.one(`select count(*) from public.razorpay_settlement_recons where bank_txn_id = '${TXN}';`)).toBe("1");
  });
});
