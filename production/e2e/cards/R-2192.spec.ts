/**
 * Card test — R-2192 "Small receipt differences: ₹1 tolerance books round-off automatically; SWIFT /
 * bank charge on wire receipts booked as expense, not left due" (R-2550).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2192` (needs the R-2192 migration on the local DB —
 * `npm run localhost:update` after the push).
 *
 * Data: the local scenario `receipt-gaps` (scripts/dev/scenario.mjs — local docker DB only), reloaded
 * fresh before the steps and cleared after them:
 *   · SCN Round Off Traders — INV-SCN-RG-1 ₹13,106 + a ₹13,105 NEFT line naming them (₹1 short);
 *   · SCN Wire Exports — INV-SCN-RG-2 ₹50,000 + a ₹49,500 RTGS wire (the bank kept ₹500).
 * Both lines sit on the scenarios' own account "SCN HDFC Current ··7788". The steps use the real
 * Banking page and Reconcile sheet; the books (invoice Paid, Bank Charges expense) are read from the
 * local DB — the exact check.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
// @ts-expect-error — plain .mjs helpers (no types)
import { SCN_ACCOUNT_ID } from "../../scripts/dev/scenarios/index.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const SCENARIO = "receipt-gaps";
const LINE = { roundOff: "c2192000-0000-4000-8000-000000000003", wire: "c2192000-0000-4000-8000-000000000004" };
const INV = { roundOff: "INV-SCN-RG-1", wire: "INV-SCN-RG-2" };

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
  if (why || !c) throw new Error(`R-2192 card test refuses to read test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/** Load (fresh) or `--clear` this spec's own scenario — LOCAL docker DB only (scenario.mjs refuses anything else). */
function scenario(...flags: string[]): void {
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...flags], { cwd: PROD, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`scenario ${SCENARIO} ${flags.join(" ")} failed (exit ${r.status}): ${out.trim()}`);
  if (/skipped/.test(out)) throw new Error(`scenario ${SCENARIO} was skipped — the R-2192 migration is not on the local DB yet (npm run localhost:update).`);
}

/** Open the line's Reconcile sheet from its row on the Banking page. */
async function openReconcile(page: Page, txnId: string): Promise<void> {
  await openAppPage(page, `/accounting/banking/${SCN_ACCOUNT_ID}`);
  const row = page.locator(`tr[data-txn-id="${txnId}"]`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /^Reconcile$/ }).click();
  await expect(page.getByText("Reconcile transaction", { exact: true })).toBeVisible({ timeout: 30_000 });
  // A money-in line: "Customer" (the guessed customer may already have opened it).
  const customerTile = page.getByRole("radio", { name: /^Customer/ });
  if (await customerTile.count()) {
    if ((await customerTile.first().getAttribute("aria-checked")) !== "true") await customerTile.first().click();
  }
}

/** Pick the customer (when not guessed) and the open invoice (when not pre-selected). */
async function pickInvoice(page: Page, customer: string, invoiceId: string): Promise<void> {
  const who = page.getByLabel("Customer who paid");
  await expect(who).toBeVisible({ timeout: 30_000 });
  const chosen = await who.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "");
  if (!chosen.includes(customer)) await who.selectOption({ label: (await who.locator("option", { hasText: customer }).first().textContent()) ?? customer });
  const mode = page.getByRole("button", { name: /open quote \/ invoice/i });
  if (await mode.count()) {
    if ((await mode.first().getAttribute("aria-pressed")) !== "true") await mode.first().click();
  }
  const item = page.getByRole("radiogroup", { name: "Open quotes and invoices" }).getByRole("radio", { name: new RegExp(invoiceId) });
  await expect(item).toBeVisible({ timeout: 30_000 });
  if ((await item.getAttribute("aria-checked")) !== "true" && !(await item.isChecked().catch(() => false))) await item.click();
}

test.describe("R-2192 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    scenario();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    scenario("--clear");
  });

  test("Step 1: a credit ₹1 short of its invoice → matched with a ₹1 round-off, invoice Paid in full", async () => {
    // The bank list's chip says it is the invoice, ₹1 off.
    await openAppPage(page, `/accounting/banking/${SCN_ACCOUNT_ID}`);
    const row = page.locator(`tr[data-txn-id="${LINE.roundOff}"]`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole("button", { name: new RegExp(`Matches invoice ${INV.roundOff}.*₹1 round-off`) })).toBeVisible({ timeout: 30_000 });

    await openReconcile(page, LINE.roundOff);
    await pickInvoice(page, "SCN Round Off Traders", INV.roundOff);
    // ₹1 short → "Round off ₹1 — settled in full" is already chosen; nothing to answer.
    await expect(page.getByRole("button", { name: /Round off ₹1 — settled in full/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: new RegExp(`Record ₹13,105 on ${INV.roundOff} & reconcile`) }).last().click();
    await expect(page.getByText(/₹1 less came in — written off as round-off/)).toBeVisible({ timeout: 60_000 });

    const [status] = psql(`select status || '|' || coalesce(paid_amount, 0) from public.invoices where id = '${INV.roundOff}';`);
    expect(status).toBe("paid|13106");
    const [matched] = psql(`select coalesce(matched_to_type, 'none') || '|' || (select count(*) from public.bank_receipt_round_offs r where r.bank_txn_id = t.id and r.amount = 1)
                              from public.bank_transactions t where t.id = '${LINE.roundOff}';`);
    expect(matched).toBe("payment|1");
  });

  test("Step 2: a wire short by a SWIFT fee → enter the bank charge → invoice Paid, ₹500 Bank Charges", async () => {
    await openReconcile(page, LINE.wire);
    await pickInvoice(page, "SCN Wire Exports", INV.wire);
    await expect(page.getByText(/₹500 less/)).toBeVisible();
    await page.getByRole("button", { name: /Bank \/ SWIFT charge ₹500 — settled in full/ }).click();
    await expect(page.getByText(/Booked as a Bank Charges expense on this bank line/)).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`Record ₹49,500 on ${INV.wire} & reconcile`) }).last().click();
    await expect(page.getByText(/₹500 bank \/ SWIFT charge booked as Bank Charges/)).toBeVisible({ timeout: 60_000 });

    const [status] = psql(`select status from public.invoices where id = '${INV.wire}';`);
    expect(status).toBe("paid");
    const [exp] = psql(`select category || '|' || amount || '|' || paid from public.expenses where id = 'EXP-FXC-${LINE.wire}';`);
    expect(exp).toBe("Bank Charges|500|true");
  });
});
