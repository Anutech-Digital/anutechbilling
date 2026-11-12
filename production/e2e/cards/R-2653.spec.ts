/**
 * Card test — R-2653 (G-RECON N1): "Read from Zoho again" keeps what is already read and can be
 * limited to one Zoho deposit account (e.g. Razorpay Clearing). The read itself (list calls + only
 * new/changed details) is proven by unit tests with a fake Zoho (fy-import/scan-r2653.test.ts:
 * 2,576 payments → 13 list calls, 0 detail calls; Razorpay only → 13 + 258) — never real Zoho here.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2653`.
 *
 * Data: planted by this spec on the LOCAL docker DB — a COMPLETE FY 2025-26 receipts read of E2E Test
 * Co with two made-up payments (one deposited to "Razorpay Clearing R2653", one to "HDFC R2653").
 * Fixed ids, planted before and removed after the run. The test never presses Read again (that would call Zoho) and
 * never imports — it only opens the dialog and picks from the list.
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const facts = (id: string, acct: string, name: string, amount: number) => JSON.stringify({
  zohoId: id, number: id.toUpperCase(), date: "2025-06-10", status: "", zohoCustomerId: "zc-r2653", customerName: "SCN Payer R2653",
  method: "bank_transfer", zohoMode: "banktransfer", reference: "", depositAccountId: acct, depositAccountName: name,
  amount, receivedPaise: amount * 100, lines: [], excess: amount, tds: 0, fee: 0, feeGst: 0, viaSettlement: false, problems: [],
});

function psql(sql: string): void {
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`R-2653 card data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** Take the two made-up payments out again (R-2565's card test reads the same company's receipts scan). */
function unplant(): void {
  psql("delete from public.zoho_fy_scan where kind = 'customerpayments' and zoho_id in ('r2653-p1', 'r2653-p2');");
}

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const t = `(select id from public.tenants where email = '${E2E_TENANT_EMAIL}')`;
  const sql = `
\\set ON_ERROR_STOP 1
insert into public.zoho_fy_scan_runs (tenant_id, kind, fy, next_page, list_done)
select ${t}, 'customerpayments', '2025-26', 2, true
on conflict (tenant_id, kind, fy) do update set list_done = true, bg_requested_at = null, bg_lease_until = null, bg_error = null;
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, detailed_at) values
  (${t}, 'customerpayments', '2025-26', 'r2653-p1', 'R2653-P1', '2025-06-10', '', '${facts("r2653-p1", "ZA-R2653-RZP", "Razorpay Clearing R2653", 1180)}'::jsonb, now()),
  (${t}, 'customerpayments', '2025-26', 'r2653-p2', 'R2653-P2', '2025-06-10', '', '${facts("r2653-p2", "ZA-R2653-HDFC", "HDFC R2653", 5000)}'::jsonb, now())
on conflict (tenant_id, kind, zoho_id) do update set payload = excluded.payload, detailed_at = excluded.detailed_at, fy = excluded.fy;
`;
  psql(sql);
}

test.describe("R-2653 — Zoho Read again keeps what is read; receipts can be limited to one deposit account", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) unplant();
  });

  test("Step 1: Invoices → FY 2025-26 receipts from Zoho → read is complete and 'Read again' offers All accounts / Only <account>", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/invoices");
    const open = page.getByRole("button", { name: "FY 2025-26 receipts from Zoho" });
    await expect(open).toBeVisible({ timeout: 90_000 });
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("status")).toContainText(/^Read all [\d,]+ payments\./, { timeout: 60_000 });
    const pick = dialog.getByTestId("fy-receipts-only-account");
    await expect(pick).toBeVisible({ timeout: 60_000 });
    const options = await pick.locator("option").allTextContents();
    expect(options[0]).toBe("All accounts");
    expect(options).toContain("Only Razorpay Clearing R2653");
    expect(options).toContain("Only HDFC R2653");
    await expect(dialog.getByRole("button", { name: "Read from Zoho again" })).toBeVisible();
  });

  test("Step 2: choose Only Razorpay Clearing → the note says other accounts stay as last read", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/invoices");
    const open = page.getByRole("button", { name: "FY 2025-26 receipts from Zoho" });
    await expect(open).toBeVisible({ timeout: 90_000 });
    await open.click();
    const dialog = page.getByRole("dialog");
    const pick = dialog.getByTestId("fy-receipts-only-account");
    await expect(pick).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByTestId("fy-receipts-only-hint")).toHaveCount(0);
    await pick.selectOption({ label: "Only Razorpay Clearing R2653" });
    await expect(dialog.getByTestId("fy-receipts-only-hint"))
      .toContainText("Only payments deposited to Razorpay Clearing R2653 are checked in Zoho. Payments to other accounts stay as last read");
    await page.keyboard.press("Escape");
  });

  test("Step 3: Read again reads only new / changed payments (list calls + their details)", async () => {
    test.skip(true, "needs real Zoho (never called from tests) — proven with a fake Zoho by fy-import/scan-r2653.test.ts (2,576 payments: 13 list calls, 0 detail calls; Razorpay only: 13 + 258)");
  });
});
