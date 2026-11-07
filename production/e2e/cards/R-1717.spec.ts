import { expect, test } from "@playwright/test";
import { onlyInCardTests, loginLocal, openAppPage } from "./card-steps";

test.describe("probe", () => {
  onlyInCardTests();
  for (const vp of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
    test(`probe ${vp.width}`, async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const ctx = await browser.newContext({ baseURL, viewport: vp });
      const page = await ctx.newPage();
      await loginLocal(page, "owner");
      await openAppPage(page, "/subscriptions");
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => {
        const t = document.querySelector("table.table-fixed") as HTMLElement | null;
        const ths = t ? [...t.querySelectorAll("thead th")].map((h) => { const r = h.getBoundingClientRect(); return `${(h.textContent||"").trim().slice(0,14)}:${Math.round(r.left)}-${Math.round(r.right)}`; }) : [];
        let p = t?.parentElement; const sc: string[] = [];
        while (p) { if (p.scrollWidth > p.clientWidth + 1) sc.push(`${p.tagName}.${p.className.slice(0,40)} ${p.scrollWidth}/${p.clientWidth}`); p = p.parentElement; }
        return { iw: innerWidth, dsw: document.documentElement.scrollWidth, rows: t?.querySelectorAll("tbody tr").length, tw: t?.getBoundingClientRect().width, ths, sc, statusTexts: [...document.querySelectorAll('td[data-col="payment"]')].slice(0,5).map(e=>(e.textContent||"").trim()) };
      });
      require("node:fs").writeFileSync(`C:/Users/mso50/Anutech-HQ/drafts/R-1717/probe-${vp.width}.json`, JSON.stringify(info, null, 1));
      await page.screenshot({ path: `C:/Users/mso50/Anutech-HQ/drafts/R-1717/probe-${vp.width}.png` });
      await ctx.close();
    });
  }
});
