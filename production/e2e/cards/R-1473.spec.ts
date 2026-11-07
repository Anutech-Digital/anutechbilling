/**
 * Card test — R-1473 "Money owed shown three different ways (dashboard, Companies, Renewals)" (R-2554).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-1473`.
 *
 * Data: the local scenario `money-owed-archived` (scripts/dev/scenario.mjs — E2E Test Co, local docker
 * DB only) is (re)loaded once per run: SCN Kochi Hosting owes ₹25,488 on its subscription; SCN Delhi
 * Traders — ARCHIVED — owes ₹19,258 on its subscription + ₹23,109 on project invoice INV-SCN-MO-1.
 * The local company has other test data too, so the totals are not ₹67,855 here: the steps check the
 * card's real rule — dashboard, Companies › Has receivables and Renewals name the SAME ₹X (less only
 * the money on subscriptions with no company, which the dashboard note itself names).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

function loadScenarioOncePerRun(): void {
  // A failed step restarts the worker and beforeAll runs again; reload only once per run (runner = parent).
  const marker = path.join(os.tmpdir(), `card-test-R-1473-${process.ppid}.loaded`);
  if (fs.existsSync(marker)) return;
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "money-owed-archived"], { cwd: prod, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`scenario money-owed-archived failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  fs.writeFileSync(marker, new Date().toISOString());
}

const rupees = (s: string) => Number(s.replace(/[₹,\s]/g, ""));

/** Dashboard Collections: "₹X to collect" and the no-company money its note names (₹0 when none). */
async function dashboardFigure(page: Page): Promise<{ total: number; noCompany: number; note: string }> {
  await openAppPage(page, "/dashboard");
  const heading = page.getByRole("heading", { name: /^₹[\d,]+ to collect$/ }).first();
  await expect(heading).toBeVisible({ timeout: 90_000 });
  const total = rupees(/₹([\d,]+)/.exec(await heading.innerText())![1]);
  const note = (await page.getByText(/^Subscription dues .* \+ project invoices/).first().innerText()).replace(/\s+/g, " ").trim();
  const nc = /₹([\d,]+) on \d+ subscriptions? with no company linked/.exec(note);
  return { total, noCompany: nc ? rupees(nc[1]) : 0, note };
}

test.describe("R-1473 — money owed: dashboard, Companies and Renewals say the same figure", () => {
  onlyInCardTests();

  test.beforeAll(() => {
    if (CARD_TESTS_ON) loadScenarioOncePerRun();
  });

  test("Step 1: Dashboard → Collections card shows '₹X to collect' with 'Subscription dues … + project invoices …'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const d = await dashboardFigure(page);
      expect(d.total).toBeGreaterThan(0);
      expect(d.note).toMatch(/Subscription dues ₹[\d.,]+[LK]? \+ project invoices ₹[\d.,]+[LK]?/);
      test.info().annotations.push({ type: "note", description: `Dashboard: ₹${d.total.toLocaleString("en-IN")} to collect — "${d.note}"` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: 'Who owes' → Companies › Has receivables lists SCN Kochi Hosting ₹25,488 and archived SCN Delhi Traders ₹42,367; the line's ₹X = dashboard ₹X", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const d = await dashboardFigure(page);
      await page.getByRole("link", { name: "Who owes" }).click();
      await expect(page).toHaveURL(/\/customers\?view=unpaid/, { timeout: 60_000 });
      const line = page.getByText(/^Subscription dues ₹[\d,]+ \+ project invoices ₹[\d,]+ = ₹[\d,]+ to collect/).first();
      await expect(line).toBeVisible({ timeout: 90_000 });
      const read = async () => (await line.innerText()).replace(/\s+/g, " ").trim();
      const firstText = await read();
      // The figure may first show while the subscriptions are still loading (7 Nov: "Subscription dues ₹0 …");
      // the step judges what it settles on within 30 s and notes the first text when it differed.
      let lineText = firstText;
      await expect.poll(async () => {
        lineText = await read();
        return rupees(/= ₹([\d,]+) to collect/.exec(lineText)?.[1] ?? "0");
      }, { timeout: 30_000, message: `Companies line vs dashboard ₹${d.total} less ₹${d.noCompany} with no company` }).toBe(d.total - d.noCompany);
      expect(lineText).toMatch(/includes 1 archived company/);
      const kochi = page.locator("main table tbody tr").filter({ hasText: "SCN Kochi Hosting" }).first();
      const delhi = page.locator("main table tbody tr").filter({ hasText: "SCN Delhi Traders" }).first();
      await expect(kochi).toContainText("₹25,488");
      await expect(delhi).toContainText("₹42,367");
      // The archived company's status badge: the list shows it as "Inactive" (the card says "Archived badge").
      await expect(delhi).toContainText(/Inactive|Archived/);
      const badge = (await delhi.innerText()).match(/Inactive|Archived/)?.[0];
      test.info().annotations.push({ type: "note", description: `Line: "${lineText}"${firstText !== lineText ? ` (first showed: "${firstText}")` : ""} · SCN Delhi Traders badge reads "${badge}" (card says "Archived badge").` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Renewals — '… unpaid on these renewals · Companies › Has receivables ₹X also has project invoices ₹…' with the same ₹X; both companies' rows show their unpaid balance", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const d = await dashboardFigure(page);
      await openAppPage(page, "/renewals", /^Renewals$/);
      const link = page.getByRole("link", { name: /unpaid on these renewals · Companies › Has receivables ₹[\d,]+ also has project invoices ₹[\d,]+/ });
      await expect(link).toBeVisible({ timeout: 90_000 });
      const text = (await link.innerText()).replace(/\s+/g, " ").trim();
      const x = rupees(/Has receivables ₹([\d,]+)/.exec(text)![1]);
      expect(x, `Renewals ₹X vs dashboard ₹${d.total} less ₹${d.noCompany}`).toBe(d.total - d.noCompany);
      expect(text).toMatch(/also has project invoices ₹[\d,]+/);
      const seen: string[] = [];
      for (const [name, tab, due] of [["SCN Kochi Hosting", /^8–30/, "₹25,488"], ["SCN Delhi Traders", /^31–60/, "₹19,258"]] as const) {
        await page.getByRole("tab", { name: tab }).click();
        await page.getByRole("searchbox", { name: /Search renewals/ }).fill(name);
        const row = page.locator("main table tbody tr").filter({ hasText: name }).first();
        await expect(row, `${name} renewal row`).toBeVisible({ timeout: 60_000 });
        const badge = row.getByRole("status").filter({ hasText: /unpaid/i }).first();
        await expect(badge, `${name}: unpaid balance badge`).toContainText(due);
        seen.push(`${name}: "${(await badge.innerText()).trim()}"`);
      }
      test.info().annotations.push({ type: "note", description: `Renewals line: "${text}" · badges: ${seen.join(" · ")} (the card calls it the 'Unpaid balance' badge).` });
    } finally {
      await page.context().close();
    }
  });
});
