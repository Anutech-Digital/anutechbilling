/**
 * Card test — R-2865: a part / renewal proforma is a payment request for its service period, never an
 * "advance". Owner, staging 16 Nov (Q-A378-27-0124, RENEWAL · PART 1 OF 1 · OCT 2026): the proforma said
 * "Advance payment for month 1 · 1 Oct–31 Oct 2026" and Record payment said "Record advance payment".
 *  - Step 1: Renewals → Overdue → a monthly row's ⋯ → Bill next part → Create proforma makes ONE proforma.
 *  - Step 2: that proforma shows the product, its seats and the period; nothing on the page says "Advance payment".
 *  - Step 3: Record payment says "Payment for <period> of <product> (Part n of N) from <customer>" and
 *            "Amount due" under the usual title — never "advance". Closed without saving.
 * Run: `node scripts/ops/card-tests.mjs R-2865`.
 *
 * NEEDS THE DB FUNCTION of migration 20261116140831 (bill_subscription_instalment writes "Payment for …").
 * Until `npm run localhost:update` has applied it on the local DB every step SKIPS itself.
 *
 * Data: the local scenario `bill-together-pair` (scripts/dev/scenario.mjs — local docker DB only), reloaded
 * fresh for the run; the proforma made here is left in place so the owner can look at it (howToCheck) — the
 * next reload removes it. No payment is saved.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const SCENARIO = "bill-together-pair";
const NAME = "SCN Pair Works";
const PLAN = "SCN Pair Standard";
const SUB = "c2859000-0000-4000-8000-000000000021";
const db = () => localDb("R-2865");

/** Load this spec's scenario — LOCAL docker DB only (scenario.mjs refuses anything else). */
function scenario(...flags: string[]): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...flags], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario ${SCENARIO} ${flags.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

/** True once the local DB carries R-2865's function body (the migration's own deploy-peek). */
function backendIn(): boolean {
  return db().one(`select coalesce((select p.prosrc like '%R-2865%' from pg_proc p
    where p.oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)')), false)::text`) === "true";
}
function needsBackend(): void {
  test.skip(!backendIn(), "R-2865's migration is not on the local DB yet — run `npm run localhost:update`, then this test again");
}

/** The live (not cancelled, not invoiced) part proforma of the scenario's Standard subscription. */
function proforma(): { id: string; name: string; description: string; notes: string } | null {
  const row = db().one(`select q.id || '|' || coalesce(q.line_items->0->>'name', '') || '|' || coalesce(q.line_items->0->>'description', '')
      || '|' || translate(coalesce(q.notes, ''), chr(10) || '|', '  ')
    from public.quotes q join public.subscription_billings b on b.id = q.subscription_billing_id
    where q.tenant_id = ${E2E_TENANT_SQL} and b.subscription_id = '${SUB}' and q.cancelled_at is null and q.invoice_id is null
    order by q.created_at desc limit 1`);
  if (!row) return null;
  const [id, name, description, notes] = row.split("|");
  return { id, name, description, notes };
}

const rowOf = (page: Page, plan: string) => page.locator("tr").filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) }).filter({ visible: true });

test.describe("R-2865 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (CARD_TESTS_ON && backendIn()) scenario("--reset"); });

  test("Step 1: Renewals → Overdue → ⋯ → Bill next part → Create proforma makes one proforma for the monthly row", async ({ browser, baseURL }) => {
    test.setTimeout(420_000);
    needsBackend();
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const row = rowOf(page, PLAN);
    await expect(row).toHaveCount(1, { timeout: 150_000 });
    const dlg = page.getByRole("dialog");
    await expect(async () => {
      if (!(await page.getByRole("menuitem", { name: /Bill next part/ }).isVisible())) await row.getByTestId("stage-more").click({ timeout: 5_000 });
      await page.getByRole("menuitem", { name: /Bill next part/ }).click({ timeout: 5_000 });
      await expect(dlg).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });
    await expect(dlg).toContainText(`${NAME} · ${PLAN}`, { timeout: 60_000 });
    const create = await onlyOne(dlg.getByRole("button", { name: /^Create (\d+ )?proformas?$/ }), "Create proforma button");
    await expect(create).toBeEnabled({ timeout: 150_000 });
    await create.click();
    await expect.poll(() => proforma()?.id ?? "", { timeout: 150_000 }).not.toBe("");
    /* what the function stored: the product line, and the short label says "Payment for …" */
    const pi = proforma()!;
    expect(pi.name).toContain(PLAN);
    expect(pi.name).toMatch(/3 seats/);
    expect(pi.description).toMatch(/^Payment for month \d+ · /);
    expect(`${pi.name} ${pi.description} ${pi.notes}`).not.toMatch(/advance/i);
    await page.context().close();
  });

  test("Step 2: the proforma shows product · seats · period; nothing on the page says 'Advance payment'", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    needsBackend();
    const pi = proforma();
    test.skip(!pi, "Step 1 made no proforma on this machine.");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${pi!.id}`);
    const main = page.getByRole("main");
    await expect(main.getByText("Payment request", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(main).toContainText(PLAN);
    await expect(main).toContainText(/3 seats/);
    await expect(main.getByText(/advance payment/i)).toHaveCount(0);
    await page.context().close();
  });

  test("Step 3: Record payment says 'Payment for … from <customer>' and 'Amount due' — never 'advance' (closed, nothing saved)", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    needsBackend();
    const pi = proforma();
    test.skip(!pi, "Step 1 made no proforma on this machine.");
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${pi!.id}`);
    const btn = page.getByRole("button", { name: /^Record payment/ }).first();
    await expect(btn).toBeVisible({ timeout: 90_000 });
    await btn.click();
    const sheet = page.getByRole("dialog", { name: "Record payment received" });
    await expect(sheet).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByText(new RegExp(`^Payment for .+ from ${NAME}\\. The tax invoice is raised when you confirm the full payment\\.$`))).toBeVisible({ timeout: 60_000 });
    await expect(sheet.getByText("Amount due", { exact: true })).toBeVisible();
    await expect(sheet.getByText(/Record advance payment|Advance due|Advance for |full advance/)).toHaveCount(0);
    await expect(sheet.getByText(/Log a payment against quote|Expected this payment|Quote total/)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.context().close();
  });
});
