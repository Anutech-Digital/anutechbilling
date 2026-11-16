/**
 * Card test — R-2622 "P&L Management (matched) view: cost of goods by the licence month".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2622`.
 *
 * Data: `node scripts/dev/r2622-pnl-matched.mjs` (run here in beforeAll; local docker DB only) adds
 * Google bill R2622-GOOGLE dated 7 Oct 2026, notes "Google Portal Bill (Aug 2026)", ₹50,000.
 * Needs the R-2156 migration on the local DB (`npm run localhost:update`).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, fillKept, onlyInCardTests, pageAs, waitForHydrated } from "./card-steps";

const PROD = path.resolve(__dirname, "..", "..");
const BILL = "R2622-GOOGLE";

async function openPnl(page: Page, from: string, to: string) {
  await page.goto("/accounting/pnl");
  await expect(page.getByRole("heading", { name: /P&L Report/ })).toBeVisible({ timeout: 60_000 });
  /* Let the first load (this month) finish before typing: on 9 Nov a From typed during hydration was
     lost, leaving From 1 Nov / To 31 Oct, and report_pnl refuses a reversed range ("didn't load").
     card-steps waitForHydrated + fillKept (R-2666): typed only after the data is on screen, and a wiped value is retyped. */
  await waitForHydrated(page, page.getByRole("button", { name: /cost of goods/i }), { idleMs: 30_000 });
  /* Both moves go back in time from "this month": From first keeps From <= To at every step. */
  await fillKept(page.locator("#pnl-from"), from);
  await fillKept(page.locator("#pnl-to"), to);
  await loaded(page);
}

/**
 * Wait until the P&L for the range on screen has loaded: the statement heading names the range and
 * the Cost of goods card (shown only with data) is there. On the local dev server the first P&L load
 * (masters + report + role) takes well over the 10 s click timeout — 9 Nov the first run failed there.
 */
async function loaded(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => { /* polling page */ });
  await expect(page.getByRole("button", { name: /cost of goods/i }).first()).toBeVisible({ timeout: 90_000 });
}

async function view(page: Page, name: "Management (matched)" | "As invoiced (GST)") {
  const btn = page.getByRole("group", { name: "View" }).getByRole("button", { name });
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await loaded(page);
}

/** Open the Cost of goods drill and return it once its tie line is shown. */
async function cogsDrill(page: Page) {
  await loaded(page);
  await page.getByRole("button", { name: /cost of goods/i }).first().click();
  const d = page.getByRole("dialog");
  const tie = d.getByTestId("pnl-drill-tie");
  await expect(tie).toBeVisible({ timeout: 60_000 });
  await expect(tie).not.toHaveAttribute("role", "alert");   // the red "does not match" note
  await expect(tie).toHaveText(/^Total ₹[\d,]+ = (Cost of goods|Licence cost) ₹[\d,]+$/);
  return d;
}

test.describe("R-2622 P&L Management (matched) view", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    const r = spawnSync(process.execPath, [path.join(PROD, "scripts", "dev", "r2622-pnl-matched.mjs")], { cwd: PROD, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`R-2622 data script failed: ${(r.stderr || r.stdout).trim()}`);
  });

  test("Step 1: Owner, October 2026, Management (matched) — the Google Aug bill is not in October; drill total = card", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openPnl(page, "2026-10-01", "2026-10-31");
    await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: "Management (matched)" })).toHaveAttribute("aria-pressed", "true");
    const d = await cogsDrill(page);
    await expect(d).toContainText("by the month the licence was used");
    await expect(d).not.toContainText(BILL);
    await page.context().close();
  });

  test("Step 2: As invoiced (GST), October 2026 — the bill is back in October; drill total = card", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openPnl(page, "2026-10-01", "2026-10-31");
    await view(page, "As invoiced (GST)");
    const d = await cogsDrill(page);
    await expect(d).toContainText(BILL);
    await page.context().close();
  });

  test("Step 3: Management (matched), August 2026 — the bill shows for Aug 2026, read from the bill text", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openPnl(page, "2026-08-01", "2026-08-31");
    await view(page, "Management (matched)");
    const d = await cogsDrill(page);
    await expect(d).toContainText(BILL);
    await expect(d).toContainText("for Aug 2026 · read from the bill text");
    await page.context().close();
  });
});
