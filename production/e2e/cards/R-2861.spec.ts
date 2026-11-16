/**
 * Card test — R-2861 "Renewals: the 6 tiles in ONE row from ~1440 px, and Status / Last bill filled fast".
 * LOCAL app, E2E Test Co, nothing planted or saved. Run: `node scripts/ops/card-tests.mjs R-2861`
 * (R2861_OUT=<file> appends the measured numbers).
 */
import { appendFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const group = (page: Page) => page.getByRole("group", { name: /Renewal totals/ });
const note = (s: string) => { if (process.env.R2861_OUT) appendFileSync(process.env.R2861_OUT, s + "\n"); };

/** How many distinct rows the six tiles sit on, and the table's first row top. */
async function tileRows(page: Page): Promise<{ rows: number; tableTop: number }> {
  return page.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label^="Renewal totals"]')!;
    const tops = new Set(Array.from(g.querySelectorAll(":scope > button")).map((b) => Math.round(b.getBoundingClientRect().top)));
    const tr = document.querySelector("table tbody tr");
    return { rows: tops.size, tableTop: Math.round(tr?.getBoundingClientRect().top ?? -1) };
  });
}

test.describe("R-2861 card test", () => {
  onlyInCardTests();

  for (const [w, h] of [[1920, 889], [1568, 800], [1440, 800], [1100, 800]] as const) {
    test(`Step 1 @${w}: the six tiles are ONE row`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      await page.setViewportSize({ width: w, height: h });
      await openAppPage(page, "/renewals", /^Renewals$/);
      await expect(group(page)).not.toHaveAttribute("aria-busy", "true", { timeout: 90_000 });
      const m = await tileRows(page);
      note(`tiles @${w}: rows=${m.rows} firstTableRowTop=${m.tableTop}`);
      expect(m.rows, `tile rows at ${w}`).toBe(1);
      await page.context().close();
    });
  }

  test("Step 1 @1280: tiles still fit (two rows allowed), nothing cut sideways", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals", /^Renewals$/);
    await expect(group(page)).not.toHaveAttribute("aria-busy", "true", { timeout: 90_000 });
    const m = await tileRows(page);
    note(`tiles @1280: rows=${m.rows} firstTableRowTop=${m.tableTop}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.context().close();
  });

  test("Step 2: Status / Last bill fill in quickly — measured", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1920, height: 889 });
    const reqs: { url: string; start: number; end: number }[] = [];
    const t0 = Date.now();
    page.on("requestfinished", async (r) => {
      if (/\/rest\/v1\/|\/api\//.test(r.url())) reqs.push({ url: r.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 110), start: 0, end: Date.now() - t0 });
    });
    await page.goto("/renewals");
    await page.locator("table tbody tr").first().waitFor({ timeout: 60_000 });
    const tTable = Date.now() - t0;
    await expect(page.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 60_000 });
    const tStatus = Date.now() - t0;
    await expect(page.locator("table").getByRole("status").filter({ hasText: "Loading…" })).toHaveCount(0, { timeout: 60_000 });
    const tAll = Date.now() - t0;
    note(`load: tableShown=${tTable}ms statusFilled=${tStatus}ms everyCellFilled=${tAll}ms requests=${reqs.length}`);
    for (const r of reqs) note(`  done@${r.end}ms ${r.url}`);
    await page.context().close();
  });
});
