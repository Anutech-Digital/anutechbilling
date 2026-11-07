/**
 * Card test — R-1495 "Website /google-workspace/pricing: page UI looks broken" (R-2550).
 *
 * Pawan marked it ✗ twice: (1) at ~1000–1280px the header's "Customer login" ran past the edge and
 * the page scrolled sideways ~44px; (2) the round "Talk to us" launcher sat over the plan cards'
 * buttons / the FAQ "+" when they were at the bottom of the screen. One test per howToCheck step,
 * on the public page (no login). Run: `node scripts/ops/card-tests.mjs R-1495`.
 *
 * "Covered" is judged like a finger would: the button is scrolled so it sits at the BOTTOM of the
 * window (where the launcher floats), then document.elementFromPoint at the button's centre and
 * near its right end must be the button itself (or something inside it).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { onlyInCardTests } from "./card-steps";

const PATH = "/google-workspace/pricing";

async function openAt(browser: Browser, baseURL: string | undefined, width: number, height = 860): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(PATH, { timeout: 120_000 });
  await expect(page.locator(".wp-cards .wp-card").first()).toBeVisible({ timeout: 60_000 });
  // First visit shows the cookie banner over the bottom of the page; answer it like a visitor.
  // It appears after the page hydrates, so wait for it (a context that already answered never sees it).
  const necessary = page.getByRole("button", { name: /Only necessary/i });
  if (await necessary.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false)) {
    await necessary.click();
    await expect(page.locator(".consent-banner")).toHaveCount(0, { timeout: 10_000 });
  }
  return page;
}

/** No sideways scroll, and "Customer login" (desktop header) wholly inside the window and on top. */
async function headerFits(page: Page, width: number) {
  const m = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('header a[aria-label^="Customer login"]');
    const r = el?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const nav = document.querySelector<HTMLElement>('header nav[aria-label="Main"]');
    return {
      navFits: nav ? nav.scrollWidth <= nav.clientWidth : false,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      login: r ? { left: r.left, right: r.right, width: r.width } : null,
      loginOnTop: Boolean(el && hit && (hit === el || el.contains(hit))),
    };
  });
  expect(m.scrollWidth, `${width}px: page is wider than the window (sideways scroll)`).toBeLessThanOrEqual(m.innerWidth);
  expect(m.login, `${width}px: Customer login button in the header`).not.toBeNull();
  expect(m.login!.left, `${width}px: Customer login starts inside the window`).toBeGreaterThanOrEqual(0);
  expect(m.login!.right, `${width}px: Customer login ends inside the window`).toBeLessThanOrEqual(m.innerWidth);
  expect(m.loginOnTop, `${width}px: nothing sits over Customer login`).toBe(true);
  expect(m.navFits, `${width}px: every menu fits in the header (none cut off)`).toBe(true);
}

/** Plan columns in one row = cards sharing the first card's top edge. */
async function cardsPerRow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tops = [...document.querySelectorAll(".wp-cards .wp-card")].map((c) => Math.round(c.getBoundingClientRect().top));
    return tops.filter((t) => Math.abs(t - tops[0]) <= 2).length;
  });
}

/**
 * Scroll each target so it sits at the bottom of the window, then check that the point at its
 * centre and near its right end is the target itself. Returns the ones something else covered.
 */
async function coveredAtBottom(page: Page, selector: string): Promise<string[]> {
  const count = await page.locator(selector).count();
  expect(count, `targets for ${selector}`).toBeGreaterThan(0);
  const covered: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.evaluate(([sel, idx]) => {
      const el = document.querySelectorAll<HTMLElement>(sel as string)[idx as number];
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.bottom - (window.innerHeight - 6));
    }, [selector, i] as const);
    // The launcher reacts to an IntersectionObserver callback; give it a frame or two.
    await page.waitForTimeout(350);
    const res = await page.evaluate(([sel, idx]) => {
      const el = document.querySelectorAll<HTMLElement>(sel as string)[idx as number];
      const r = el.getBoundingClientRect();
      const pts: Array<[number, number]> = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.right - Math.min(12, r.width / 4), r.top + r.height / 2],
      ];
      const inView = r.bottom <= window.innerHeight && r.top >= 0;
      const bad = pts
        .map(([x, y]) => document.elementFromPoint(x, y))
        .filter((hit) => !(hit && (hit === el || el.contains(hit))))
        .map((hit) => (hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 30)} "${(hit.textContent ?? "").trim().slice(0, 20)}"` : "nothing"));
      return { name: (el.textContent ?? "").trim().slice(0, 40), inView, bad };
    }, [selector, i] as const);
    if (res.inView && res.bad.length) covered.push(`${res.name} ← covered by ${res.bad[0]}`);
  }
  return covered;
}

const CARD_BUTTONS = ".wp-cards .wp-cta a, .wp-cards .wp-cta button";
const FAQ_ROWS = ".wp-faq summary";

test.describe("R-1495 — Workspace pricing page fits and nothing floats over its buttons", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test("Step 1: ~1000px wide — Customer login fully shown, no sideways scroll, plan buttons not covered", async ({ browser, baseURL }) => {
    const page = await openAt(browser, baseURL, 1000);
    try {
      await headerFits(page, 1000);
      expect(await coveredAtBottom(page, CARD_BUTTONS), "plan card buttons covered at 1000px").toEqual([]);
      expect(await coveredAtBottom(page, FAQ_ROWS), "FAQ rows covered at 1000px").toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: 1100 / 1200 / 1280 / 1400 / 1440 — header fits, 4 cards a row from 1280 (2 below), buttons clear", async ({ browser, baseURL }) => {
    for (const width of [1100, 1200, 1280, 1400, 1440]) {
      const page = await openAt(browser, baseURL, width);
      try {
        await headerFits(page, width);
        expect(await cardsPerRow(page), `${width}px: plan cards per row`).toBe(width >= 1280 ? 4 : 2);
        expect(await coveredAtBottom(page, CARD_BUTTONS), `plan card buttons covered at ${width}px`).toEqual([]);
        expect(await coveredAtBottom(page, FAQ_ROWS), `FAQ rows covered at ${width}px`).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  });

  test("Step 3: phone (390px) — no sideways scroll, the AI button never covers Buy now / Get a GST quote / FAQ +, and comes back on the compare table", async ({ browser, baseURL }) => {
    const page = await openAt(browser, baseURL, 390, 844);
    try {
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(sw[0], "390px: page wider than the phone").toBeLessThanOrEqual(sw[1]);
      expect(await cardsPerRow(page), "390px: one plan card per row").toBe(1);
      expect(await coveredAtBottom(page, CARD_BUTTONS), "plan card buttons covered on phone").toEqual([]);
      expect(await coveredAtBottom(page, FAQ_ROWS), "FAQ rows covered on phone").toEqual([]);

      // The launcher is not gone for good: on the compare table (no cards / FAQ on screen) it is back.
      await page.locator(".wp-compare tbody tr").nth(6).evaluate((el) => {
        window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight / 2);
      });
      await expect(page.locator(".agent-launcher")).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.context().close();
    }
  });
});
