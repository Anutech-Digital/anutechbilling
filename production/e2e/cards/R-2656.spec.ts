/**
 * Card test — R-2656 (G-RECON N3): Banking → "Find transfer pairs" lists the own-account transfer and
 * the reversal with the reason, "Book N pairs" books them, "Undo this run" opens the lines again.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2656`.
 *
 * Data: planted by this spec on the LOCAL docker DB — accounts "SCN Pair HDFC" (current) and
 * "SCN Pair FD" (fixed deposit) with four open lines: ₹26,560 "TRF TO FD SWEEP" out of HDFC and
 * "PRINCIPAL DEPOSITED" into the FD the next day; ₹1,656 "UPI-PHONEPE-SCN-626560001656" out and "UPIRET-626560001656-PHONEPE-SCN"
 * back the next day on HDFC. Fixed ids, re-planted open on each run (an earlier test run's pair of
 * these lines is released, never deleted). Booking may also book other sure pairs already open in the local company;
 * Step 3 undoes the whole run, so they open again too.
 */
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const HDFC = "c2656000-0000-4000-8000-0000000000a1";
const FD = "c2656000-0000-4000-8000-0000000000a2";
const T = (n: number) => `c2656000-0000-4000-8000-00000000000${n}`;

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
begin;
-- release (never delete) a run pair of these lines: deleting a run would drop the record of OTHER
-- pairs it booked, and their Undo with it
update public.bank_pair_run_lines set undone_at = now()
 where undone_at is null and (out_txn_id in ('${T(1)}','${T(3)}') or in_txn_id in ('${T(2)}','${T(4)}'));
update public.bank_transactions set matched_to_type = null, matched_to_id = null, matched_at = null, matched_by = null, match_confidence = null
 where id in ('${T(1)}','${T(2)}','${T(3)}','${T(4)}');
delete from public.bank_transactions where id in ('${T(1)}','${T(2)}','${T(3)}','${T(4)}');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance)
select v.id::uuid, t.id, v.name, 'HDFC', v.kind, 0
  from public.tenants t, (values ('${HDFC}', 'SCN Pair HDFC', 'current'), ('${FD}', 'SCN Pair FD', 'fixed_deposit')) v(id, name, kind)
 where t.email = '${E2E_TENANT_EMAIL}'
on conflict (id) do nothing;
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source)
select v.id::uuid, t.id, v.acc::uuid, v.d::date, v.descr, v.dr, v.cr, 'manual'
  from public.tenants t, (values
    ('${T(1)}', '${HDFC}', '2026-11-02', 'TRF TO FD SWEEP SCN', 26560, 0),
    ('${T(2)}', '${FD}',   '2026-11-03', 'PRINCIPAL DEPOSITED SCN', 0, 26560),
    ('${T(3)}', '${HDFC}', '2026-11-04', 'UPI-PHONEPE-SCN-626560001656', 1656, 0),
    ('${T(4)}', '${HDFC}', '2026-11-05', 'UPIRET-626560001656-PHONEPE-SCN', 0, 1656)) v(id, acc, d, descr, dr, cr)
 where t.email = '${E2E_TENANT_EMAIL}';
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2656 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** The button shows once the accounts and the role have loaded (owner / accountant). */
async function openPairs(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: "Find transfer pairs" });
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
}

test.describe("R-2656 — Find transfer & reversal pairs on Banking", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: Banking → Find transfer pairs → ₹26,560 own transfer and ₹1,656 reversal ready to book, with the reason", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/banking");
    await openPairs(page);
    const ready = page.getByRole("region", { name: "Ready to book" });
    await expect(ready).toContainText("₹26,560", { timeout: 60_000 });
    await expect(ready).toContainText("SCN Pair FD");
    await expect(ready).toContainText("₹1,656");
    await expect(ready).toContainText("Reversal word on the money coming back");
    await expect(ready).toContainText("FD / card / OD word and the other line is in that FD / card / OD account");
  });

  test("Step 2: Book N pairs → both pairs booked", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/banking");
    await openPairs(page);
    await page.getByRole("button", { name: /^Book \d+ pairs?$/ }).click();
    await expect(page.getByRole("status").filter({ hasText: /pairs? booked \(\d+ lines reconciled\)/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("dialog").getByText("SCN Pair FD")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByText(/Last run: \d+ pairs? booked/)).toBeVisible();
  });

  test("Step 3: Undo this run → the lines are open again and back in Ready to book", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/accounting/banking");
    await openPairs(page);
    await page.getByRole("button", { name: "Undo this run" }).click();
    await expect(page.getByText(/pairs? undone — the lines are open again/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Ready to book" })).toContainText("₹26,560", { timeout: 60_000 });
  });
});
