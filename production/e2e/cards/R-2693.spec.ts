/**
 * Card test — R-2693 "482 Zoho FY 2025-26 customer payments never imported" (part 1: nothing left out
 * silently; a USD payment shown in USD).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2693`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed Zoho ids, removed after):
 * a COMPLETE customer-payments scan for FY 2025-26 holding two payments that the import leaves out —
 *   · CT-R2693-USD  USD 663.05 at Zoho's rate 88.2 (₹58,481) — foreign-currency, not imported yet;
 *   · CT-R2693-INR  ₹1,000 on INV/25-26/R2693X, an invoice that is not in the app.
 * Skipped when the company already has its own FY 2025-26 receipts scan (never mixed with real reads).
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const IDS = "'ct-r2693-usd','ct-r2693-inr'";
const SCAN = `public.zoho_fy_scan where tenant_id = ${E2E_TENANT_SQL} and kind = 'customerpayments' and fy = '2025-26'`;

const USD = JSON.stringify({
  zohoId: "ct-r2693-usd", number: "CT-R2693-USD", date: "2025-12-02", status: "", zohoCustomerId: "zc-ct", customerName: "CT R2693 Overseas LLC",
  method: "bank_transfer", zohoMode: "Bank Remittance", reference: "INW-CT-R2693", depositAccountId: "zct2693", depositAccountName: "CT R2693 Zoho Bank",
  amount: 58481, receivedPaise: 5848101, lines: [{ zohoInvoiceId: "zi-ct-r2693", invoiceNumber: "INV/25-26/R2693U", settle: 663, tds: 0 }],
  excess: 0, tds: 0, fee: 0, feeGst: 0, viaSettlement: false, currency: "USD", foreignAmount: 663.05, fxRate: 88.2,
  problems: ["Received in USD in Zoho — foreign-currency payments are not imported yet; book it from its bank line (Banking → the inward USD line → Reconcile, exchange gain / loss there)."],
});
const INR = JSON.stringify({
  zohoId: "ct-r2693-inr", number: "CT-R2693-INR", date: "2025-06-10", status: "", zohoCustomerId: "zc-ct2", customerName: "CT R2693 Buyer",
  method: "bank_transfer", zohoMode: "Bank Transfer", reference: "UTR-CT-R2693", depositAccountId: "zct2693", depositAccountName: "CT R2693 Zoho Bank",
  amount: 1000, receivedPaise: 100000, lines: [{ zohoInvoiceId: "zi-ct-missing", invoiceNumber: "INV/25-26/R2693X", settle: 1000, tds: 0 }],
  excess: 0, tds: 0, fee: 0, feeGst: 0, viaSettlement: false, currency: "INR", foreignAmount: null, fxRate: null, problems: [],
});

/** The company has its own receipts scan (not ours) → this test must not mix with it. */
function otherScan(): boolean {
  return Number(localDb("R-2693").one(`select count(*) from ${SCAN} and zoho_id not in (${IDS})`)) > 0;
}

function clean(): void {
  localDb("R-2693").psql(`begin;
    delete from ${SCAN} and zoho_id in (${IDS});
    delete from public.zoho_fy_scan_runs r where r.tenant_id = ${E2E_TENANT_SQL} and r.kind = 'customerpayments' and r.fy = '2025-26'
      and not exists (select 1 from ${SCAN});
    commit;`);
}

function seed(): void {
  const q = (s: string) => s.replace(/'/g, "''");
  localDb("R-2693").psql(`begin;
    insert into public.zoho_fy_scan_runs (tenant_id, kind, fy, next_page, list_done)
      values (${E2E_TENANT_SQL}, 'customerpayments', '2025-26', 2, true)
      on conflict (tenant_id, kind, fy) do update set list_done = true;
    insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, payload, detailed_at) values
      (${E2E_TENANT_SQL}, 'customerpayments', '2025-26', 'ct-r2693-usd', 'CT-R2693-USD', '2025-12-02', '${q(USD)}'::jsonb, now()),
      (${E2E_TENANT_SQL}, 'customerpayments', '2025-26', 'ct-r2693-inr', 'CT-R2693-INR', '2025-06-10', '${q(INR)}'::jsonb, now());
    commit;`);
}

test.describe("R-2693 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  let skipWhy: string | null = null;

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    clean();
    if (otherScan()) { skipWhy = "E2E Test Co already has its own FY 2025-26 receipts scan — not mixed with this test's data."; return; }
    seed();
  });
  test.afterAll(() => { if (CARD_TESTS_ON && !skipWhy) clean(); });

  test("Step 1: Invoices → FY 2025-26 receipts from Zoho — every scanned payment is counted, each left-out one listed with its reason; the USD one in USD", async ({ browser, baseURL }) => {
    test.skip(!!skipWhy, skipWhy ?? "");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/invoices", /Invoices/);
    await page.getByRole("button", { name: "FY 2025-26 receipts from Zoho" }).click();
    const dlg = page.getByRole("dialog", { name: /FY 2025-26 receipts from Zoho/ });
    const summary = dlg.getByTestId("fy-receipts-summary");
    await expect(summary).toContainText("2 Zoho payments", { timeout: 60_000 });
    await expect(summary).toContainText("2 left out");
    const reasons = dlg.getByTestId("fy-receipts-skip-reasons");
    await expect(reasons).toContainText("Received in USD in Zoho");
    await expect(reasons).toContainText("is not an FY sale imported from Zoho here");
    await dlg.getByText("Show the payments left out").click();
    const list = dlg.getByTestId("fy-receipts-left-out");
    await expect(list).toContainText("CT-R2693-USD");
    await expect(list).toContainText("$663.05 (₹58,481)");
    await expect(list).not.toContainText("₹663");
    await expect(list).toContainText("INV/25-26/R2693X is not an FY sale imported from Zoho here");
  });

  test("Step 2: Check first — the sum line accounts for every payment", async () => {
    test.skip(true, "Needs an importable payment (an imported Zoho FY sale + a mapped bank account) — the sum line is covered by zoho-fy-receipts-import-dialog.test.tsx (R-2693); staging check after the train.");
  });
});
