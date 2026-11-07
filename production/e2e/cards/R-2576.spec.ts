/**
 * Card test — R-2576 "Print / Save as PDF always light" (R-2550 card test).
 *
 * Since R-2187 the app follows the OS theme ("System"), so a laptop in dark mode puts `.dark` on
 * <html>. Before this card the print styles only set `body { background: white }` — every theme
 * token stayed dark, so a customer's invoice / quote PDF printed light ink on white (or dark).
 * Now globals.css @media print resets every token to its light value and color-scheme to light.
 *
 * How: OS dark + theme System (no stored choice) → page.emulateMedia({ media: "print" }) is what
 * Chrome's print preview renders; the computed colours of the real page are read there.
 *
 * Data: scenario "zero-ref-credits" (R-2458) — invoice INV-SCN-ZR-3 and quote Q-SCN-ZR-3 in E2E Test Co
 * (local docker DB only; scenario.mjs refuses anything else). Loaded only when not already there,
 * and then cleared again at the end, so the test leaves the local books as it found them.
 * Run: `node scripts/ops/card-tests.mjs R-2576`.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const INVOICE = "INV-SCN-ZR-3";
const QUOTE = "Q-SCN-ZR-3";
const SCENARIO = "zero-ref-credits";

function scenario(...args: string[]) {
  execFileSync(process.execPath, ["scripts/dev/scenario.mjs", SCENARIO, ...args], { stdio: "pipe", timeout: 120_000 });
}

/** Relative luminance (0 = black, 1 = white) of a computed CSS colour "rgb(r, g, b)" / "rgba(…)". */
function luminance(css: string): number {
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  const ch = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(Number(m[1])) + 0.7152 * ch(Number(m[2])) + 0.0722 * ch(Number(m[3]));
}

/** The colours the printed page is made of: page background, body text, and the document's own number text. */
async function printedColours(page: Page, docNo: string) {
  return page.evaluate((no) => {
    const cs = (el: Element) => getComputedStyle(el);
    // The element whose own text shows the document number (e.g. "INV-SCN-ZR-3" in the heading), visible on paper.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let docText: Element | null = null;
    let seen = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !(n.textContent ?? "").includes(no)) continue;
      seen++;
      if (el.getClientRects().length > 0 && cs(el).visibility !== "hidden") { docText = el; break; }
    }
    return {
      seen,
      bodyHead: (document.body.innerText ?? "").slice(0, 200),
      htmlDark: document.documentElement.classList.contains("dark"),
      colorScheme: cs(document.documentElement).colorScheme,
      paperToken: cs(document.documentElement).getPropertyValue("--paper").trim(),
      bodyBg: cs(document.body).backgroundColor,
      bodyText: cs(document.body).color,
      docText: docText ? cs(docText).color : null,
    };
  }, docNo);
}

/** OS dark, no stored theme (= System), then open the document as the print preview renders it. */
async function openPrinted(page: Page, path: string, docNo: string) {
  await page.emulateMedia({ colorScheme: "dark", media: "screen" });
  await page.goto("/dashboard");
  await page.evaluate(() => localStorage.removeItem("theme"));
  await openAppPage(page, path);
  // The document itself has loaded (not a skeleton) before the print view is read.
  await expect(page.locator("main").getByText(docNo).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")), {
    message: "theme System + OS dark → the app is dark on screen (R-2187)",
  }).toBe(true);
  // On screen it really is dark — this card must not change that.
  const screenBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(luminance(screenBg), `on-screen body background ${screenBg} stays dark`).toBeLessThan(0.1);
  await page.emulateMedia({ colorScheme: "dark", media: "print" });
}

function expectLightPaper(c: Awaited<ReturnType<typeof printedColours>>, what: string) {
  expect(c.htmlDark, `${what}: <html> still has .dark (OS dark) while printing`).toBe(true);
  expect(c.colorScheme, `${what}: color-scheme in print`).toBe("light");
  expect(c.paperToken, `${what}: --paper token in print = the light value`).toBe("45 33% 97%");
  expect(luminance(c.bodyBg), `${what}: page background ${c.bodyBg} is light`).toBeGreaterThan(0.85);
  expect(luminance(c.bodyText), `${what}: body text ${c.bodyText} is dark`).toBeLessThan(0.05);
  expect(c.docText, `${what}: the document number is on the printed page (text nodes with it: ${c.seen}; page starts: ${c.bodyHead})`).not.toBeNull();
  expect(luminance(c.docText!), `${what}: document number text ${c.docText} is dark`).toBeLessThan(0.1);
}

test.describe("R-2576 — print / Save as PDF is light even on a dark OS", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let loadedByUs = false;

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const inv = await page.request.get(`/invoices/${INVOICE}`, { timeout: 120_000 });
      const quo = await page.request.get(`/quotes/${QUOTE}`, { timeout: 120_000 });
      if (!inv.ok() || !quo.ok()) {
        scenario("--reset");
        loadedByUs = true;
      }
    } finally {
      await page.context().close();
    }
  });

  test.afterAll(() => {
    if (loadedByUs) scenario("--clear");
  });

  test("Step 1: laptop in dark mode, app theme System — the app is dark on screen", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // openPrinted asserts the on-screen dark state before switching to print.
      await openPrinted(page, `/invoices/${INVOICE}`, INVOICE);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: an invoice → Print / Save as PDF renders on light paper with dark text", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openPrinted(page, `/invoices/${INVOICE}`, INVOICE);
      expectLightPaper(await printedColours(page, INVOICE), INVOICE);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: a quote prints the same way — light and readable", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openPrinted(page, `/quotes/${QUOTE}`, QUOTE);
      expectLightPaper(await printedColours(page, QUOTE), QUOTE);
    } finally {
      await page.context().close();
    }
  });
});
