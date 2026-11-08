/**
 * Card test — R-2565 "FY receipts import: a Razorpay payment Zoho recorded with bank charges is
 * importable — receipt = the full amount, fee = a separate Bank Charges expense" (R-2550).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2565` (needs the R-2565 migration on the local DB —
 * `npm run localhost:update` after the push).
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only; everything is taken out again
 * in afterAll): the local company has no Zoho connection, so the test writes what "Read from Zoho"
 * would have stored —
 *   · one FY 2025-26 sale from Zoho (CT/25-26/R2565, ₹11,800 = ₹10,000 + 18% GST) for the customer
 *     "CT R2565 Razorpay Buyer", imported with import_zoho_fy_sales (as the local owner);
 *   · one Zoho customer payment into "Razorpay Clearing": ₹11,800 applied to it, Razorpay's fee ₹278
 *     (₹236 + ₹42 GST) taken off as Zoho bank_charges — the facts as the R-2565 normaliser stores them;
 *   · the company's books start set to 1 Apr 2025 when it has none (put back afterwards).
 * Steps 1–2 use the real dialog (Invoices → "FY 2025-26 receipts from Zoho"); step 3 presses Import
 * and reads the result from the local DB (invoice paid, one fee expense) — the Expenses list filters
 * by date, so the DB is the exact check.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL, E2E_BANK_NAME } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUST = "c2565000-0000-4000-8000-000000000001";
const CUST_NAME = "CT R2565 Razorpay Buyer";
const INV_ZOHO = "ct2565-zi1";
const INV_NO = "CT/25-26/R2565";
const PAY_ZOHO = "ct2565-p1";
const PAY_REF = "pay_CT2565RZPFEE01";
const STATE = path.join(os.tmpdir(), "card-test-R-2565-books-start.json");

/* ── local docker DB (same guard as scripts/dev/scenario.mjs) ── */
function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env: Record<string, string> = {};
  const f = path.join(PROD, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`R-2565 card test refuses to write test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function tenantAndOwner(): { tenant: string; owner: string } {
  const rows = psql(`select t.id || '|' || (select u.id from public.users u where u.tenant_id = t.id and u.role = 'owner' and u.is_active order by u.created_at limit 1)
                       from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';`);
  if (rows.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${rows.length}`);
  const [tenant, owner] = rows[0].split("|");
  if (!owner) throw new Error("E2E Test Co has no active owner");
  return { tenant, owner };
}

/** As the local owner (auth.uid()), inside one psql transaction. */
const asOwner = (owner: string) =>
  `select set_config('request.jwt.claims', json_build_object('sub', '${owner}', 'role', 'authenticated')::text, true);\nset local role authenticated;`;

/** Take back everything an earlier run made (receipts + fee expense, the sale, scan rows, batches, the customer). */
function clear(tenant: string, owner: string): void {
  psql([
    "begin;",
    asOwner(owner),
    `select public.remove_zoho_fy_receipts_import(b.id, 'R-2565 card test cleanup')
       from public.zoho_fy_import_batches b
      where b.tenant_id = '${tenant}' and b.kind = 'customerpayments' and b.removed_at is null
        and exists (select 1 from public.zoho_fy_receipts r where r.batch_id = b.id and r.zoho_payment_id = '${PAY_ZOHO}');`,
    `select public.remove_zoho_fy_sales_import(b.id, 'R-2565 card test cleanup')
       from public.zoho_fy_import_batches b
      where b.tenant_id = '${tenant}' and b.kind = 'invoices' and b.removed_at is null
        and exists (select 1 from public.invoices i where i.tenant_id = b.tenant_id and i.zoho_invoice_id = '${INV_ZOHO}');`,
    "reset role;",
    `delete from public.activity_log where tenant_id = '${tenant}' and entity = 'zoho_fy_import_batch'
       and entity_id in (select id::text from public.zoho_fy_import_batches where tenant_id = '${tenant}' and remove_reason = 'R-2565 card test cleanup');`,
    `delete from public.zoho_fy_import_batches where tenant_id = '${tenant}' and remove_reason = 'R-2565 card test cleanup';`,
    `delete from public.zoho_fy_scan where tenant_id = '${tenant}' and zoho_id in ('${INV_ZOHO}', '${PAY_ZOHO}');`,
    `delete from public.zoho_fy_scan_runs r where r.tenant_id = '${tenant}' and r.fy = '2025-26' and r.kind = 'customerpayments'
       and not exists (select 1 from public.zoho_fy_scan s where s.tenant_id = r.tenant_id and s.kind = r.kind and s.fy = r.fy);`,
    `delete from public.customers where tenant_id = '${tenant}' and id = '${CUST}'
       and not exists (select 1 from public.invoices i where i.customer_id = '${CUST}')
       and not exists (select 1 from public.payments p where p.customer_id = '${CUST}');`,
    "commit;",
  ].join("\n"));
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8")) as { booksStart: string | null };
    psql(`update public.tenants set books_start_date = ${s.booksStart ? `'${s.booksStart}'` : "null"} where id = '${tenant}';`);
    fs.rmSync(STATE);
  }
}

function seed(): void {
  const { tenant, owner } = tenantAndOwner();
  clear(tenant, owner);
  const bs = psql(`select coalesce(books_start_date::text, '') from public.tenants where id = '${tenant}';`)[0] ?? "";
  fs.writeFileSync(STATE, JSON.stringify({ booksStart: bs || null }));
  if (!bs || bs > "2025-04-01") psql(`update public.tenants set books_start_date = '2025-04-01' where id = '${tenant}';`);

  const sale = {
    number: INV_NO, date: "2025-06-01", dueDate: "2025-06-01", status: "sent", customerName: CUST_NAME, gstin: "", posStateCode: "07",
    head: "cgst_sgst", currency: "INR", fxRate: null, taxable: 10000, tax: 1800, amount: 11800, taxRate: 18, appGstTreatment: "registered_regular",
    problems: [], lines: [{ name: "Card test R-2565 seat", hsn: "998315", qty: 1, rate: 10000, taxable: 10000 }],
  };
  const payment = {
    zohoId: PAY_ZOHO, number: "CT-RZP-2565", date: "2025-06-10", status: "", zohoCustomerId: "ct2565-zc", customerName: CUST_NAME,
    method: "razorpay", zohoMode: "Razorpay", reference: PAY_REF, depositAccountId: "ct2565-zrzp", depositAccountName: "Razorpay Clearing",
    amount: 11800, receivedPaise: 1180000, lines: [{ zohoInvoiceId: INV_ZOHO, invoiceNumber: INV_NO, settle: 11800, tds: 0 }],
    excess: 0, tds: 0, fee: 278, feeGst: 42, viaSettlement: true, problems: [],
  };
  psql([
    "begin;",
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, notes) values
       ('${CUST}', '${tenant}', '${CUST_NAME}', 'Delhi', '07', 'business', 'accounts@ct2565.example', 'Card test R-2565 — local only');`,
    `insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
       ('${tenant}', 'invoices', '2025-26', '${INV_ZOHO}', '${INV_NO}', '2025-06-01', 'sent', '${JSON.stringify(sale)}'::jsonb, now()),
       ('${tenant}', 'customerpayments', '2025-26', '${PAY_ZOHO}', 'CT-RZP-2565', '2025-06-10', '', '${JSON.stringify(payment)}'::jsonb, now());`,
    `insert into public.zoho_fy_scan_runs (tenant_id, kind, fy, next_page, list_done) values ('${tenant}', 'customerpayments', '2025-26', 2, true)
       on conflict (tenant_id, kind, fy) do update set list_done = true;`,
    asOwner(owner),
    `select public.import_zoho_fy_sales('2025-26', '[{"zoho_invoice_id": "${INV_ZOHO}", "customer_id": "${CUST}"}]'::jsonb, false);`,
    "commit;",
  ].join("\n"));
  const inv = psql(`select count(*) from public.invoices where tenant_id = '${tenant}' and zoho_invoice_id = '${INV_ZOHO}';`)[0];
  if (inv !== "1") throw new Error(`R-2565 seed: the FY sale was not imported (${inv})`);
}

async function openDialog(page: Page) {
  await openAppPage(page, "/invoices");
  await page.getByRole("button", { name: "FY 2025-26 receipts from Zoho" }).click();
  const dlg = page.getByRole("dialog", { name: /FY 2025-26 receipts from Zoho/ });
  await expect(dlg.getByTestId("fy-receipts-summary")).toBeVisible({ timeout: 60_000 });
  /* Zoho's "Razorpay Clearing" → the company's bank account (the money reaches it in Razorpay's settlement). */
  const pick = dlg.getByRole("combobox", { name: /App account for Zoho's Razorpay Clearing/ });
  const option = pick.locator("option").filter({ hasText: E2E_BANK_NAME }).first();
  await pick.selectOption({ value: (await option.getAttribute("value")) ?? "" });
  await expect(dlg.getByTestId("fy-receipts-fee")).toBeVisible({ timeout: 60_000 });
  return dlg;
}

test.describe.serial("R-2565 — Razorpay fee payment imports: full receipt, fee as Bank Charges", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) { const { tenant, owner } = tenantAndOwner(); clear(tenant, owner); } });

  test("Step 1: Owner → Invoices → FY receipts import → the Razorpay fee payment → Check first", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openDialog(page);
      await expect(dlg.getByTestId("fy-receipts-summary")).toContainText(/1\s+to record \(₹11,800 received/);
      await expect(dlg.getByTestId("fy-receipts-fee")).toHaveText(/1 Razorpay payment · fee ₹278 booked as Bank Charges/);
      await dlg.getByRole("button", { name: /Check first/ }).click();
      const fee = dlg.getByTestId("fy-receipts-part-fee");
      await expect(fee).toHaveText(/1 Razorpay payment · fee ₹278/, { timeout: 120_000 });
      await expect(dlg.getByText(/Check result \(nothing saved\): 1 receipts/)).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: it is importable — not in 'book by hand'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openDialog(page);
      await expect(dlg.getByText(/book it by hand/i)).toHaveCount(0);
      await expect(dlg.getByText(/bank charges off this payment/i)).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: after Import — the invoice is fully paid, the gateway fee is a separate expense", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openDialog(page);
      await dlg.getByRole("button", { name: /Check first/ }).click();
      await expect(dlg.getByTestId("fy-receipts-part-fee")).toBeVisible({ timeout: 120_000 });
      const imp = dlg.getByRole("button", { name: /Import 1 receipts/ });
      await expect(imp).toBeEnabled();
      await imp.click();
      await expect(dlg.getByText(/Recorded: 1 receipts/)).toBeVisible({ timeout: 120_000 });
    } finally {
      await page.context().close();
    }
    const { tenant } = tenantAndOwner();
    const [inv] = psql(`select i.status || '|' || i.paid_amount::int || '|' || coalesce(i.net_payable, i.amount)::int
                          from public.invoices i where i.tenant_id = '${tenant}' and i.zoho_invoice_id = '${INV_ZOHO}';`);
    expect(inv, "invoice status | paid | total").toBe("paid|11800|11800");
    const exp = psql(`select e.category || '|' || e.amount || '|' || e.gst_paid || '|' || e.description
                        from public.expenses e join public.payments p on e.id = 'EXP-RZPFEE-' || p.id::text
                       where p.tenant_id = '${tenant}' and p.reference = '${PAY_REF}';`);
    expect(exp, "one Razorpay fee expense").toHaveLength(1);
    expect(exp[0]).toMatch(/^Bank Charges\|278\|42\|Razorpay fee on pay_CT2565RZPFEE01/);
    const [recv] = psql(`select coalesce(sum(p.amount), 0)::int from public.payments p where p.tenant_id = '${tenant}' and p.reference = '${PAY_REF}';`);
    expect(recv, "receipt = the full amount, fee not taken off").toBe("11800");
    test.info().annotations.push({ type: "note", description: "Paid status and the fee expense read from the local DB (the Expenses list filters by date)." });
  });
});
