/**
 * Card test — R-2817 "Renewals: one day count per row — Due column, chip, drawer and AI use the same
 * anchor date".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2817`.
 *
 * Reads the rows already in E2E Test Co's Overdue tab (Greentin Check 2095, SCN Bit Labs … from earlier
 * scenarios) — writes no data. Step 3 is skipped when Greentin Check 2095 is not in the local company.
 */
import { expect, test, type Locator } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

/** The table rows of the open tab, once every chip has loaded (no "Loading status" skeleton left). */
async function loadedRows(table: Locator): Promise<Locator[]> {
  await expect(table.getByTestId("renewal-row").first()).toBeVisible({ timeout: 90_000 });
  await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 120_000 });
  return table.getByTestId("renewal-row").all();
}

test.describe("R-2817 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test("Step 1: Overdue tab — every row's Due column day count = its chip's overdue days", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const rows = await loadedRows(page.getByTestId("renewals-table"));
    let compared = 0;
    for (const r of rows) {
      const chip = (await r.getByTestId("stage-chip").getAttribute("title")) ?? (await r.getByTestId("stage-chip").innerText());
      const m = /overdue (\d+)d/i.exec(chip);
      if (!m) continue;   // "Part not billed (Nov)" etc. — no day count on the chip
      const dueSub = (await r.locator('[data-cell="due"] p').nth(1).innerText()).trim();
      /* a sent quote's "exp. in Nd" line replaces the day words — then the date's tooltip carries the anchor */
      if (/^exp\.|expired/.test(dueSub)) continue;
      expect(dueSub, `row: ${(await r.innerText()).replace(/\s+/g, " ").slice(0, 80)}`).toBe(`${m[1]}d ago`);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  });

  test("Step 2: Overdue tab — no row says 'Due today' or 'Due in'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await loadedRows(table);
    for (const chip of await table.getByTestId("stage-chip").all()) {
      const words = `${(await chip.getAttribute("title")) ?? ""} ${await chip.innerText()}`;
      expect(words).not.toMatch(/Due today|Due in \d+d/);
    }
  });

  test("Step 3: Greentin Check 2095 — Due column shows the part's date (1 Oct) and the same days as the chip", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await loadedRows(table);
    const row = table.getByTestId("renewal-row").filter({ hasText: "Greentin Check 2095" }).filter({ has: page.locator('[data-stage="sent"], [data-stage="invoiced"]') });
    const n = await row.count();
    test.skip(n === 0, "Greentin Check 2095 with an open part bill is not in the local company");
    /* the customer has more than one subscription: the one whose part was due 1 Oct (renews 31 Oct) */
    const dates: string[] = [];
    for (const r of await row.all()) {
      const date = (await r.locator('[data-cell="due"] p').first().innerText()).trim();
      dates.push(date);
      if (date !== "1 Oct 26") continue;
      const chip = (await r.getByTestId("stage-chip").getAttribute("title")) ?? "";
      const m = /overdue (\d+)d/i.exec(chip);
      expect(m, chip).not.toBeNull();
      await expect(r.locator('[data-cell="due"] p').nth(1)).toHaveText(`${m![1]}d ago`);
      expect(chip).toContain("part due 1 Oct 2026");
    }
    expect(dates, "a Greentin Check row dated by its part (1 Oct), not its renewal date (31 Oct)").toContain("1 Oct 26");
    expect(dates).not.toContain("31 Oct 26");
  });
});
