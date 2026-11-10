/**
 * Card test — R-1427 "/leads freezes when Google contacts fetch returns 410" (R-2550).
 *
 * Pawan's two ✗ Galat notes (17 + 24 Oct): the "Not available" message is right, but after
 * closing ANY dialog opened from the /leads "More" menu (Import from Google, Import CSV, Send
 * campaign, Share enquiry form) the page stayed frozen — `body` kept `pointer-events: none`,
 * Filter and the lead rows did not respond until a reload.
 *
 * One test per More-menu dialog, on the LOCAL app (E2E Test Co) as the Owner, with REAL clicks:
 * More → item → the dialog's own Close → then body must not be `pointer-events: none`, and the
 * Filter button and a lead row must answer a real click (Playwright's click fails on an element
 * that does not receive pointer events). Run: `node scripts/ops/card-tests.mjs R-1427`.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

/** Body's computed pointer-events — "none" is the freeze. */
async function bodyPointerEvents(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).pointerEvents);
}

/** More → <item>; the dialog opens; its own Close (or the ✕) shuts it. */
async function openAndCloseFromMore(page: Page, item: RegExp): Promise<void> {
  await page.getByRole("button", { name: /^More$/ }).click();
  await page.getByRole("menuitem", { name: item }).click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // The owner's path: the dialog's own Close button. Prefer a visible "Close"/"Cancel" text
  // button; else the ✕ (sr-only "Close").
  const textClose = dialog.getByRole("button", { name: /^(Close|Cancel)$/ });
  if (await textClose.count()) await textClose.first().click();
  else await dialog.getByRole("button", { name: /close/i }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
}

/** After Close: body not frozen, Filter opens, a lead row takes a click. */
async function pageStillWorks(page: Page): Promise<void> {
  // Radix restores body styles on unmount — give it the same beat a person's next click has.
  await expect.poll(() => bodyPointerEvents(page), { timeout: 5_000 }).not.toBe("none");

  const filter = page.getByRole("button", { name: /^Filter/ }).first();
  await filter.click({ timeout: 5_000 });
  await expect(page.getByRole("menu")).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => bodyPointerEvents(page), { timeout: 5_000 }).not.toBe("none");

  const row = page.locator("[data-lead-id]").first();
  await expect(row, "the local company should have at least one lead on /leads").toBeVisible({ timeout: 30_000 });
  // trial: Playwright checks the row would receive the click (fails if the page is frozen)
  // without opening the lead drawer, so the next step starts from the same page.
  await row.click({ trial: true, timeout: 5_000 });
}

const DIALOGS: { step: string; item: RegExp }[] = [
  { step: "Step 1+2: More → Import from Google → Close", item: /Import from Google/ },
  { step: "Step 3a: More → Import CSV → Close", item: /Import CSV/ },
  { step: "Step 3b: More → Send campaign → Close", item: /Send campaign/ },
  { step: "Step 3c: More → Share enquiry form → Close", item: /Share enquiry form/ },
];

test.describe("R-1427 — /leads stays usable after closing a More-menu dialog", () => {
  onlyInCardTests();

  for (const d of DIALOGS) {
    test(`${d.step}: Filter + lead rows still respond`, async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const page = await pageAs(browser, baseURL, "owner");
      try {
        await openAppPage(page, "/leads");
        await expect(page.getByRole("button", { name: /^More$/ })).toBeVisible({ timeout: 60_000 });
        await openAndCloseFromMore(page, d.item);
        await pageStillWorks(page);
        // Twice in a row — the second open/close is where a saved "none" would be put back.
        await openAndCloseFromMore(page, d.item);
        await pageStillWorks(page);
      } finally {
        await page.context().close();
      }
    });
  }

  test("Step 3d: all four dialogs one after another, page still works", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/leads");
      await expect(page.getByRole("button", { name: /^More$/ })).toBeVisible({ timeout: 60_000 });
      for (const d of DIALOGS) await openAndCloseFromMore(page, d.item);
      await pageStillWorks(page);
    } finally {
      await page.context().close();
    }
  });
});
