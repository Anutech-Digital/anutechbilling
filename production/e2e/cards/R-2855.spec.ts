/**
 * Card test — R-2855 "Renewals header + tiles: four different 'owed/due' numbers that don't add up, and
 * tiles change value while the page loads" (owner's human test on staging, 16 Nov 2026).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co, its own renewals — nothing is planted,
 * saved or sent) through the Local test login. Run: `node scripts/ops/card-tests.mjs R-2855`.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const TILES = ["Overdue", "Due in 30 days", "Due in 31–60 days", "Due in 61–90 days", "Won't renew", "Renewed this month"];

const tileGroup = (page: Page) => page.getByRole("group", { name: /Renewal totals/ });

/** Wait until the tiles carry their numbers (no placeholder left). */
async function tilesReady(page: Page): Promise<void> {
  await expect(tileGroup(page)).toBeVisible({ timeout: 60_000 });
  await expect(tileGroup(page)).not.toHaveAttribute("aria-busy", "true", { timeout: 90_000 });
  await expect(tileGroup(page).getByTestId("renewal-tile-loading")).toHaveCount(0);
}

test.describe("R-2855 card test", () => {
  onlyInCardTests();

  test("Step 1: Renewals kholo — upar ke dabbon mein number ek baar aaye aur phir badle nahi", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    /* from the very first paint: note every text each tile ever shows (label → the distinct texts, in order) */
    await page.addInitScript(() => {
      const seen: Record<string, string[]> = {};
      (window as unknown as { __r2855: Record<string, string[]> }).__r2855 = seen;
      const read = () => {
        const group = document.querySelector('[role="group"][aria-label^="Renewal totals"]');
        if (!group) return;
        for (const b of Array.from(group.querySelectorAll("button"))) {
          const label = b.querySelector("p")?.textContent ?? "";
          const text = (b.textContent ?? "").trim();
          const list = (seen[label] ??= []);
          if (list[list.length - 1] !== text) list.push(text);
        }
      };
      new MutationObserver(read).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await openAppPage(page, "/renewals", /^Renewals$/);
    await tilesReady(page);
    /* stay a little longer: a late read must not move a number either */
    await page.waitForTimeout(5_000);
    const seen = await page.evaluate(() => (window as unknown as { __r2855: Record<string, string[]> }).__r2855);
    for (const label of TILES) {
      const texts = seen[label] ?? [];
      const withMoney = texts.filter((t) => t.includes("₹"));
      expect(withMoney, `${label}: every text with a ₹ this tile showed — ${JSON.stringify(texts)}`).toHaveLength(1);
      /* and before that one text there was only the placeholder (the label + "Loading"), never a number */
      for (const t of texts.slice(0, texts.indexOf(withMoney[0]))) expect(t).not.toMatch(/₹|\d+ renewals?/);
    }
    await page.context().close();
  });

  test("Step 2: har number ke neeche likha ho woh kya hai; 'Renewed this month' ka '% of ₹X' wala ₹X dabbe mein dikhe", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals", /^Renewals$/);
    await tilesReady(page);
    const group = tileGroup(page);
    for (const key of ["overdue", "due30", "due60", "due90", "wontRenew", "renewedMonth"]) {
      const cap = group.getByTestId(`renewal-tile-caption-${key}`);
      await expect(cap).toBeVisible();
      await expect(cap).toHaveText(/\S/);
    }
    await expect(group.getByTestId("renewal-tile-caption-overdue")).toHaveText("Renewal value overdue");
    await expect(group.getByTestId("renewal-tile-caption-wontRenew")).toHaveText("Renewal value leaving");
    /* nothing under a number is cut with "…" at this width (1280) */
    const cut = await group.locator('[data-testid^="renewal-tile-caption-"]').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    expect(cut, "captions cut at 1280").toEqual([]);
    await expect(group.getByRole("button", { name: /^Overdue/ })).toHaveAttribute("title", /Renewal value overdue, before GST \(each renewal's next-term bill; not unpaid bills\)/);

    /* Renewed this month: the caption is "N% of <Mon>'s ₹X" — the ₹X the % divides by is ON the tile */
    const renewed = await onlyOne(group.getByRole("button", { name: /^Renewed this month/ }), "Renewed this month tile");
    const cap = (await group.getByTestId("renewal-tile-caption-renewedMonth").textContent()) ?? "";
    expect(cap).toMatch(/^(\d+% of \w{3}'s ₹\S+|Nothing due in \w{3})$/);
    const title = (await renewed.getAttribute("title")) ?? "";
    expect(title).not.toContain("(Overdue + Due tiles)");
    expect(title).toMatch(/renewals dated in \w{3}, paid \+ not paid, before GST \(₹[\d,]+\)/);

    /* the header's own figure says what it is — bills and instalments due, not the tiles' renewal value */
    const dues = page.getByTestId("renewals-dues-line");
    if (await dues.count()) {
      await expect(dues).toHaveText(/^(Bills and instalments due: ₹[\d,]+ unpaid on these renewals|No bill or instalment unpaid on these renewals)/);
      await expect(dues).toHaveAttribute("title", /Invoices already raised on these renewals that are not fully paid/);
    }
    await page.context().close();
  });

  test("Step 3: sidebar ke Renewals number par mouse le jao — likha aaye woh kya gin raha hai; Status / Last bill bhar jaayein", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const started = Date.now();
    await openAppPage(page, "/renewals?bucket=overdue", /^Renewals$/);
    await tilesReady(page);
    /* once the tiles have their numbers, no Status chip or Last bill cell is still loading */
    await expect(page.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("table").getByRole("status").filter({ hasText: "Loading…" })).toHaveCount(0, { timeout: 30_000 });
    test.info().annotations.push({ type: "loaded-in", description: `${Date.now() - started} ms from opening the page (incl. the page's own wait for the network) on this local dev server — staging's 2 s target is measured after the train` });

    /* the badge is its own link; its hover says what the number counts, in the page's words.
       The sidebar's counts arrive after the page (their own read) — wait for the badge before judging. */
    const badge = page.locator('a[title*="overdue or due within 7 days"]').filter({ visible: true });
    await badge.first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => { /* no badge: judged below */ });
    if (await badge.count() === 0) {
      test.info().annotations.push({ type: "note", description: "No Renewals badge on the sidebar after 60 s (nothing overdue or due within 7 days in this company right now) — hover text is unit-tested (tiles-r2855.test.tsx)." });
    } else {
      const b = await onlyOne(badge, "Renewals sidebar badge");
      await expect(b).toHaveAttribute("title", /^\d+ renewals? overdue or due within 7 days$/);
      await b.hover();
    }
    await page.context().close();
  });
});
