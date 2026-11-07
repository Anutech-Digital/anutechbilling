/**
 * Card test — R-2172 "Error toasts are hidden behind open dialogs/drawers app-wide" (R-2550).
 *
 * Found by R-2168 (Settings → Integrations → Sandbox dialog: the Save error showed only after
 * the dialog was closed) and R-2095b (reconcile drawer: the toast's button sat "behind" the
 * drawer). A Radix modal (ui/dialog, ui/sheet) sets `body { pointer-events: none }` while it is
 * open; the toaster lives in <body>, outside the modal, so it inherited "none": a click on the
 * toast went THROUGH it to the modal's overlay — the toast could not be dismissed or used, and
 * the click closed the dialog instead.
 *
 * Each step opens a REAL modal on the local app (E2E Test Co, Owner), makes its own Save fail
 * (the request is answered by the test with a refusal — nothing reaches the server), and then:
 *   - the error toast is visible and the topmost element at its centre is the toast itself;
 *   - its ✕ takes a REAL click (Playwright refuses a click on an element that would not get it);
 *   - the dialog / drawer is still open after that click.
 * Run: `node scripts/ops/card-tests.mjs R-2172`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const ERROR_TOAST = "[data-sonner-toast][data-type=error]";

/** True when the element painted at the toast's centre is the toast (or inside it). */
async function toastIsOnTop(page: Page, toast: Locator): Promise<boolean> {
  const box = await toast.boundingBox();
  if (!box) return false;
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit?.closest("[data-sonner-toast]");
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

/** The error toast is on top, its ✕ takes a real click, and the modal stays open. */
async function toastUsableOverModal(page: Page, modal: Locator, text: RegExp): Promise<void> {
  const toast = page.locator(ERROR_TOAST).filter({ hasText: text }).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(modal).toBeVisible();
  await expect.poll(() => toastIsOnTop(page, toast), { timeout: 5_000 }).toBe(true);

  // Hover keeps sonner from auto-closing it while we click; the click must reach the button.
  await toast.hover({ timeout: 5_000 });
  await toast.getByRole("button", { name: /close toast/i }).click({ timeout: 5_000 });
  await expect(toast).toHaveCount(0, { timeout: 5_000 });
  await expect(modal, "clicking the toast must not close the dialog/drawer under it").toBeVisible();
}

test.describe("R-2172 — an error toast is visible and clickable over an open dialog or drawer", () => {
  onlyInCardTests();

  test("Step 1: Settings → Integrations → Sandbox dialog → refused Save → error toast usable while the dialog is open", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // The save is answered here with the refusal the owner saw — nothing is sent to the server.
      await page.route("**/api/integrations/sandbox", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "Live key cannot be used with the test URL (R-2172 card test)" }),
        });
      });
      await openAppPage(page, "/settings?tab=integrations");
      const card = page.locator("div", { has: page.getByText("Sandbox.co.in", { exact: true }) })
        .filter({ has: page.getByRole("button", { name: /^(Setup|Manage)$/ }) }).last();
      await card.getByRole("button", { name: /^(Setup|Manage)$/ }).click({ timeout: 60_000 });
      const dialog = page.getByRole("dialog").filter({ hasText: "GSTIN verification" });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.locator("#sbx-api-key").fill("r2172-dummy-key");
      await dialog.locator("#sbx-api-secret").fill("r2172-dummy-secret");
      await dialog.getByRole("button", { name: /^Save/ }).click();
      await toastUsableOverModal(page, dialog, /Live key cannot be used/);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Leads → Quick add drawer → refused Save → error toast usable while the drawer is open", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // Only the INSERT is refused (PostgREST's own error shape); reads go through.
      await page.route("**/rest/v1/leads*", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "42501", message: "Save refused (R-2172 card test)", details: null, hint: null }),
        });
      });
      await openAppPage(page, "/leads");
      await page.getByRole("button", { name: /^Quick add$/ }).click({ timeout: 60_000 });
      const sheet = page.getByRole("dialog").last();
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await sheet.locator("#q-contact-phone").fill("98765 43210");
      await sheet.getByPlaceholder("e.g. Rajesh K").fill("R2172 Toast Check");
      await sheet.getByRole("button", { name: /^Save lead$/ }).click();
      await toastUsableOverModal(page, sheet, /./);
    } finally {
      await page.context().close();
    }
  });
});
