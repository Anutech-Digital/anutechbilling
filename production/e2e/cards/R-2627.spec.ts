/**
 * Card test — R-2627 "Paying an accepted quote from a bank line on a GST-filed day must not create a tax invoice
 * dated in the filed month".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2627`.
 *
 * Data: scenario gst-filed-quote (scripts/dev/scenarios/gst-filed-quote.sql) — SCN Filed Quote Buyer, accepted
 * quote Q-SCN-GFQ-1 ₹5,900 (no invoice), money-in lines 18 Sep ₹5,900 and 6 Oct ₹5,900 on SCN HDFC Current.
 * Loaded fresh before step 1; after the last step the scenario is cleared and E2E Test Co's "GST returns filed
 * up to" is cleared again (local docker DB only).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const NAME = "SCN Filed Quote Buyer";
const TXN = { sep: "c2627000-0000-4000-8000-000000000011", oct: "c2627000-0000-4000-8000-000000000012" };
const LINE = { sep: "FILED QUOTE BUYER-SEPT", oct: "FILED QUOTE BUYER-OCT" };
const QUOTE = "Q-SCN-GFQ-1";

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
  if (why || !c) throw new Error(`R-2627 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function scenario(flag: "--reset" | "--clear"): void {
  container(); // the local guard first
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "gst-filed-quote", flag], { cwd: PROD, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario gst-filed-quote ${flag} failed: ${(r.stderr || r.stdout || "").trim()}`);
}

/** The owner's setting is cleared again (postgres session — the guard trigger refuses only request logins). */
function clearSetting(): void {
  const c = container();
  psql(c, `update public.tenants set gst_filed_through = null where email = '${E2E_TENANT_EMAIL}';`);
}

function matched(id: string): string {
  const c = container();
  return (psql(c, `select coalesce(matched_to_type, '') from public.bank_transactions where id = '${id}';`)[0] ?? "").trim();
}

async function openLine(page: Page, text: string, txn: string): Promise<Locator> {
  await openAppPage(page, `/accounting/banking/${ACCT}?txn=${txn}`); // R-1895: scrolled to the line
  const row = page.locator("main table tbody tr").filter({ hasText: text }).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  /* The row paints before its action cell under load (12:44 run: row there, Reconcile not yet) — wait for it. */
  const reconcile = row.getByRole("button", { name: /^Reconcile$/ });
  await expect(reconcile).toBeVisible({ timeout: 90_000 });
  await reconcile.click();
  const dlg = page.getByRole("dialog", { name: "Reconcile transaction" });
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  return dlg;
}

/** The owner's one-click path: the dialog suggests the customer's only open item (₹5,900 = due on the quote),
 *  the customer guessed from the bank line — so there is no customer picker to fill (12:47 run). */
async function payQuote(_page: Page, dlg: Locator): Promise<void> {
  await expect(dlg.getByText(`${NAME} · One-time sale ${QUOTE}`)).toBeVisible({ timeout: 90_000 });
  await dlg.getByRole("button", { name: "Looks right — reconcile" }).click();
}

function invoicesOfQuote(): string[] {
  const c = container();
  return psql(c, `select id || '|' || invoice_date from public.invoices where quote_id = '${QUOTE}' order by id;`);
}

test.describe("R-2627 — no new tax invoice in a GST-filed month when a bank line pays a quote", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(480_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    clearSetting();
    scenario("--reset");
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON) return;
    clearSetting();
    scenario("--clear");
  });

  test("Step 1: Accounting → Overview → GST returns filed up to → September 2026 → Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting");
      const card = page.getByTestId("gst-filed-through-card");
      await expect(card).toBeVisible({ timeout: 60_000 });
      /* The stored month loads first — typing before it lands is overwritten by it and Save stays disabled
         (12:34 run: Save not clickable; same race R-2621 fixed in 9c0e55603). beforeAll cleared the setting. */
      await expect(page.getByTestId("gst-filed-through-text")).toContainText("Not set", { timeout: 60_000 });
      await card.getByLabel("GST returns filed up to (month)").fill("2026-09");
      await expect(card.getByRole("button", { name: "Save" })).toBeEnabled({ timeout: 30_000 });
      await card.getByRole("button", { name: "Save" }).click();
      await page.getByRole("button", { name: "Save" }).last().click(); // the confirm dialog
      await expect(page.getByTestId("gst-filed-through-text")).toContainText("GST returns are filed up to September 2026", { timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Banking → 18 Sep ₹5,900 line → Reconcile → suggestion Q-SCN-GFQ-1 → Looks right — reconcile → refused, no invoice, line unmatched", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openLine(page, LINE.sep, TXN.sep);
      await payQuote(page, dlg);
      await expect(page.getByText(/GST for Sep 2026 is already filed/).first()).toBeVisible({ timeout: 120_000 });
      expect(matched(TXN.sep)).toBe("");
      expect(invoicesOfQuote()).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: 6 Oct ₹5,900 line (open month) → suggestion Q-SCN-GFQ-1 → Looks right — reconcile → paid, invoice dated 6 Oct", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dlg = await openLine(page, LINE.oct, TXN.oct);
      await payQuote(page, dlg);
      /* "Looks right — reconcile" books and closes the dialog (no "Done" panel) — wait on the books themselves. */
      await expect.poll(() => matched(TXN.oct), { timeout: 240_000, message: "the 6 Oct line is reconciled" }).toBe("payment");
      await expect.poll(() => invoicesOfQuote().join(","), { timeout: 30_000, message: "one invoice on the quote, dated 6 Oct 2026" })
        .toMatch(/^[^,|]+\|2026-10-06$/);
    } finally {
      await page.context().close();
    }
  });
});
