/**
 * Card test — R-2598 "Online fee on a 0% (export / SEZ without payment) bill still adds 18% GST".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2598`.
 *   - Step 1 loads the scenarios usd-inw-lines (export invoice INV-SCN-USD-1 ₹1,68,000 at 0%) and
 *     zero-ref-credits (INV-SCN-ZR-1 ₹11,800 at 18%) on the LOCAL DB.
 *   - Steps 2–3 open both invoices as the Owner and read the "Online fee" card. With the company
 *     default (customer pays, 2%): 0% bill → ₹3,429 fee, no GST (3,36,000 ÷ 98 = 3,428.57);
 *     18% bill → ₹242 + ₹44 GST, as before.
 */
import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

function scenario(name: string): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", name], { encoding: "utf8", timeout: 180_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

async function onlineFeeLine(page: Page): Promise<string> {
  const line = page.getByText(/^Online fee:/).first();
  await expect(line).toBeVisible({ timeout: 60_000 });
  return (await line.textContent()) ?? "";
}

test.describe("R-2598 online fee carries the bill's GST rate", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;

  test("Step 1: load the export and the 18% invoices (local scenarios)", async ({ browser, baseURL }) => {
    for (const name of ["usd-inw-lines", "zero-ref-credits"]) {
      const r = scenario(name);
      test.skip(!r.ok, `scenario ${name} could not load on the local DB: ${r.out.slice(0, 200)}`);
    }
    page = await pageAs(browser, baseURL, "owner");
  });

  test("Step 2: export invoice INV-SCN-USD-1 (0%) — online fee has no GST", async () => {
    await openAppPage(page, "/invoices/INV-SCN-USD-1");
    const text = await onlineFeeLine(page);
    test.skip(!/customer pays/.test(text), `company setting is not "customer pays" here: ${text}`);
    expect(text).toContain("₹3,429 (no GST — 0% bill)");
    expect(text).toContain("₹1,71,429 in all");
  });

  test("Step 3: 18% invoice INV-SCN-ZR-1 — unchanged ₹242 + ₹44 GST", async () => {
    await openAppPage(page, "/invoices/INV-SCN-ZR-1");
    const text = await onlineFeeLine(page);
    test.skip(!/customer pays/.test(text), `company setting is not "customer pays" here: ${text}`);
    expect(text).toContain("₹286 (₹242 + ₹44 GST)");
    expect(text).toContain("₹12,086 in all");
  });
});
