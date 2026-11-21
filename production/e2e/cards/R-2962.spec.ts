/**
 * Card test — R-2962: opening a page from a Help AI answer keeps help open with the same chat,
 * and docked help no longer covers the page. Run: `node scripts/ops/card-tests.mjs R-2962`.
 *
 * The AI answer is stubbed: this test answers POST /api/ai/help itself (page.route) with a fixed
 * reply carrying one "→ Open Expenses" action, so no model is called and the same answer comes
 * back every run. No data is written.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const QUESTION = "How do I record an expense?";
const REPLY = {
  reply: "1. Open Expenses. 2. Press Add expense. 3. Fill the amount and save.",
  actions: [{ kind: "open", label: "Open Expenses", href: "/accounting/expenses" }],
  checklist: [],
  followUps: [],
  bugDraft: null,
  ai: true,
};

async function stubHelpAnswer(page: Page) {
  await page.route("**/api/ai/help", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REPLY) })
      : route.continue());
}

test.describe("R-2962 Help stays open when an answer's link opens a page", () => {
  onlyInCardTests();

  test("ask → press '→ Open Expenses' → Expenses opens, help still open with the same chat, page not under the panel", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner"); /* 1280 × 900 */
    try {
      await stubHelpAnswer(page);
      await openAppPage(page, "/dashboard");

      /* Step 1: open Help (AI) and ask. */
      await page.locator('[data-topbar="help"]').filter({ visible: true }).first().click();
      const help = page.getByRole("dialog", { name: "Help" });
      await expect(help).toBeVisible();
      await help.getByLabel("Your question").fill(QUESTION);
      await help.getByRole("button", { name: "Send" }).click();
      const action = help.getByRole("button", { name: /Open Expenses/ });
      await expect(action).toBeVisible({ timeout: 30_000 });

      /* Step 2: the answer's link opens the page — help stays open with the same chat. */
      await action.click();
      await expect(page).toHaveURL(/\/accounting\/expenses/, { timeout: 120_000 });
      await expect(page.getByRole("heading", { name: "Expenses", level: 1 })).toBeVisible({ timeout: 60_000 });
      await expect(help).toBeVisible();
      await expect(help.getByText(QUESTION)).toBeVisible();
      await expect(help.getByText(/Press Add expense/)).toBeVisible();

      /* Step 3: the page's content ends left of the docked panel — nothing sits under it. */
      const { contentRight, panelLeft } = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const panel = document.querySelector('section[role="dialog"][aria-label="Help"]')!;
        const pr = parseFloat(getComputedStyle(main).paddingRight) || 0;
        return { contentRight: main.getBoundingClientRect().right - pr, panelLeft: panel.getBoundingClientRect().left };
      });
      expect(contentRight).toBeLessThanOrEqual(panelLeft + 1);

      /* Closing help gives the page its full width back. */
      await help.getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("main")!).paddingRight) || 0)).toBe(0);
    } finally {
      await page.context().close();
    }
  });
});
