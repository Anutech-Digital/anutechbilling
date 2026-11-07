/**
 * Card test — R-2566 "Invoices and Bank Reconciliation freeze for 1–2 min on big data" (R-2550).
 *
 * Data: `node scripts/dev/seed-big-books.mjs` (LOCAL docker DB, E2E Test Co) — bank account
 * "PERF Big HDFC ··5173" with 5,173 lines (3,500 in bank / not in books), 2,100 invoices and
 * 2,000 receipts, the 7 Nov staging shape. Run: `node scripts/ops/card-tests.mjs R-2566`.
 *
 * Each page is opened once to warm the dev server's compile, then timed. What is timed is what
 * froze the tab on staging — the BROWSER's part: picking the account → the BRS numbers on screen
 * (fetch of all 5,173 lines + paint), and the invoices data arriving → the first rows painted.
 * Each must be ≤ 3 s. The whole page-open time is written as a note only: on a local DEV server
 * it is mostly the server compiling the page, which a production build does not do. The numbers must be the full calculation's: the BRS figures are worked
 * out here by buildBrs over EVERY line read straight from the local DB, and the Invoices "All"
 * count is the DB's own count.
 */
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, pageAs } from "./card-steps";
import { buildBrs, type BrsLine } from "../../src/lib/banking/brs";
import { rupee } from "../../src/lib/utils";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PERF_ACCOUNT_ID = "c2566000-0000-4000-8000-000000000a01";
const PAINT_MS = 3_000;

/** One value from the LOCAL docker DB (read-only). */
function localSql(sql: string): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const container = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
  if (!container) throw new Error("No local Supabase DB container — this card test needs the local DB.");
  const r = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-At", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql: ${(r.stderr || "").trim()}`);
  return (r.stdout ?? "").trim();
}

function perfData() {
  const acct = localSql(`select json_build_object('ob', opening_balance, 'od', opening_balance_date) from public.bank_accounts where id = '${PERF_ACCOUNT_ID}';`);
  test.skip(!acct, "No PERF Big HDFC account — run `node scripts/dev/seed-big-books.mjs` first (local DB, E2E Test Co).");
  const { ob, od } = JSON.parse(acct) as { ob: number; od: string };
  const lines = JSON.parse(localSql(
    `select coalesce(json_agg(json_build_object('id', id, 'txn_date', txn_date, 'description', description, 'debit', debit, 'credit', credit,
       'source', source, 'matched_to_type', matched_to_type)), '[]') from public.bank_transactions where bank_account_id = '${PERF_ACCOUNT_ID}';`,
  )) as BrsLine[];
  return { ob, od, lines };
}

/** IST today, as the page's "As of" default. */
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function trackLongTasks(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __long: number[] }).__long = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as unknown as { __long: number[] }).__long.push(e.duration); })
        .observe({ type: "longtask", buffered: true });
    } catch { /* no longtask API */ }
  });
}

async function openBrsOnPerf(page: Page): Promise<{ headingMs: number; numbersMs: number }> {
  const t0 = Date.now();
  await page.goto("/accounting/banking/brs", { waitUntil: "commit" });
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: /Bank Reconciliation Statement/ })).toBeVisible({ timeout: 60_000 });
  const headingMs = Date.now() - t0;
  const option = page.locator("#brs-bank-account option", { hasText: "PERF Big HDFC" });
  await expect(option).toHaveCount(1, { timeout: 60_000 });
  const t1 = Date.now();
  await page.selectOption("#brs-bank-account", (await option.getAttribute("value"))!);
  await expect(page.getByText(/^3500 line · net /)).toBeVisible({ timeout: 60_000 });
  return { headingMs, numbersMs: Date.now() - t1 };
}

test.describe("R-2566 — Invoices and Bank Reconciliation open fast on 5,000 bank lines + 2,000 invoices", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test("Step 1: Banking → Bank reconciliation → PERF Big HDFC shows its numbers within 3 s, every number from the full calculation", async ({ browser, baseURL }) => {
    const { ob, od, lines } = perfData();
    expect(lines).toHaveLength(5173);
    const brs = buildBrs({ openingBalance: ob, openingDate: od, asOf: istToday(), lines });
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openBrsOnPerf(page);                       // warm-up (dev server compile), not timed
      const t = await openBrsOnPerf(page);
      test.info().annotations.push({ type: "timing", description: `BRS heading ${t.headingMs} ms · account picked → numbers ${t.numbersMs} ms` });
      expect(t.numbersMs, "BRS numbers paint after picking the account").toBeLessThanOrEqual(PAINT_MS);

      const main = page.locator("main");
      await expect(main.getByText(`${brs.unbookedImports.length} line · net ${rupee(brs.totals.unbookedImports)}`, { exact: true })).toBeVisible();
      await expect(main.getByText(rupee(brs.statementBalance), { exact: true }).first()).toBeVisible();
      await expect(main.getByText(rupee(brs.bookBalance), { exact: true }).first()).toBeVisible();
      await expect(main.getByText(`+ ${rupee(brs.totals.depositsInTransit)} in transit − ${rupee(brs.totals.paymentsNotPresented)} not presented`)).toBeVisible();
      await expect(main.getByText(`${brs.unbookedImports.length} bank line(s) not in books`, { exact: false })).toBeVisible();
      await expect(main.getByText(`${brs.ignoredBeforeOpening} line(s)`, { exact: true })).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the long list does not freeze — 100 rows painted, Show more and search work, no long main-thread block", async ({ browser, baseURL }) => {
    const { ob, od, lines } = perfData();
    const brs = buildBrs({ openingBalance: ob, openingDate: od, asOf: istToday(), lines });
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await trackLongTasks(page);
      await openBrsOnPerf(page);                       // warm-up
      await page.evaluate(() => { (window as unknown as { __long: number[] }).__long = []; });
      await openBrsOnPerf(page);
      const longest = await page.evaluate(() => Math.max(0, ...(window as unknown as { __long: number[] }).__long));
      test.info().annotations.push({ type: "timing", description: `longest main-thread block ${Math.round(longest)} ms` });
      expect(longest, "longest main-thread block while the BRS paints (ms)").toBeLessThan(PAINT_MS);

      expect(await page.locator("main tr").count(), "rows painted at first (3 lists)").toBeLessThanOrEqual(300);
      await expect(page.getByText("Showing 100 of 3,500", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Show 100 more" }).first().click();
      await expect(page.getByText("Showing 200 of 3,500", { exact: true })).toBeVisible();

      const target = brs.unbookedImports[2345];
      await page.getByRole("searchbox", { name: "Search In bank, not in books" }).fill(target.description);
      await expect(page.locator("main td", { hasText: target.description }).first()).toBeVisible();
      await expect(page.getByText(`${brs.unbookedImports.length} line · net ${rupee(brs.totals.unbookedImports)}`, { exact: true })).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Invoices list paints its first rows within 3 s of its data, All count = every invoice", async ({ browser, baseURL }) => {
    const total = Number(localSql(`select count(*) from public.invoices i join public.tenants t on t.id = i.tenant_id where t.email = '${E2E_TENANT_EMAIL}';`));
    test.skip(total < 2000, "Fewer than 2,000 invoices locally — run `node scripts/dev/seed-big-books.mjs` first.");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      /* The list's own read: the last page of GET /rest/v1/invoices?select=* arriving. */
      let dataAt = 0;
      page.on("response", (r) => { if (/\/rest\/v1\/invoices\?select=\*/.test(r.url())) dataAt = Date.now(); });
      const open = async () => {
        dataAt = 0;
        const t0 = Date.now();
        await page.goto("/invoices", { waitUntil: "commit" });
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.locator("tbody tr:visible", { hasText: "INV-" }).first()).toBeVisible({ timeout: 60_000 });
        const end = Date.now();
        return { openMs: end - t0, paintMs: dataAt ? end - dataAt : end - t0 };
      };
      await open();                                    // warm-up
      const t = await open();
      test.info().annotations.push({ type: "timing", description: `Invoices: data → first rows ${t.paintMs} ms · whole open ${t.openMs} ms (${total} invoices)` });
      expect(t.paintMs, "Invoices: data arrived → first rows painted").toBeLessThanOrEqual(PAINT_MS);
      await expect(page.getByRole("tab", { name: new RegExp(`^All\\s*${total}$`) }).first()).toBeVisible();
      expect(await page.locator("tbody tr:visible").count()).toBeLessThanOrEqual(50);
    } finally {
      await page.context().close();
    }
  });
});
