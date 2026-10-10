/**
 * QA — R-464 (10 Oct 2026): on a 390px phone the floating "AI sales agent" launcher and
 * "WhatsApp us" pill covered the homepage form ("Tell us what to automate"), its Name field
 * included, and WhatsApp showed twice. Rule: one floating action on a phone, and it steps
 * aside while the form is on screen. Public page, nothing is submitted.
 */
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Visible fixed-position boxes that float over the page (launcher, WhatsApp pill). */
async function floatingBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".agent-launcher, a[aria-label='WhatsApp us']"))
      .filter((el) => getComputedStyle(el).position === "fixed" && getComputedStyle(el).display !== "none")
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })
      .filter((r) => r.width > 0 && r.height > 0),
  );
}

test("Home at 390px: floating buttons never cover the 'Tell us what to automate' form; WhatsApp once", async ({ page }) => {
  await test.step("Open / at 390px", async () => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await expect(page.locator("form#start")).toBeVisible();
    // The launcher's hide-while-form-visible rule is client JS — let the page hydrate.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  });

  await test.step("WhatsApp appears once on screen (no floating pill on a phone)", async () => {
    const visibleWa = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("a"))
        .filter((a) => /^WhatsApp us$/.test((a.textContent || "").trim()))
        .filter((a) => getComputedStyle(a).position === "fixed" && getComputedStyle(a).display !== "none").length,
    );
    expect(visibleWa, "floating WhatsApp pills visible").toBe(0);
  });

  await test.step("Scroll the form into view — no field sits under a floating button", async () => {
    for (const sel of ["#start input", "#start textarea", "#start button"]) {
      const fields = page.locator(sel);
      const n = await fields.count();
      for (let i = 0; i < n; i++) {
        const f = fields.nth(i);
        await f.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150); // let the IntersectionObserver settle
        const fb = await f.boundingBox();
        if (!fb) continue;
        for (const b of await floatingBoxes(page)) {
          expect(overlaps(fb, b), `${sel}[${i}] is under a floating button`).toBe(false);
        }
      }
    }
  });

  await test.step("No sideways scroll at 390px", async () => {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(sw, "page width").toBeLessThanOrEqual(390);
  });
});
