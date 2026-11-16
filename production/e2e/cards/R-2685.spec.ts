/**
 * Card test — R-2685 "Big bank accounts freeze the browser".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2685
 *
 * Data (made fresh on every run, removed after): a bank account "CT R2685 HDFC ··2685" with 5,230 imported
 * lines like staging Excel HDFC 4523 (UPI / NEFT / IMPS / salary / POS narrations, ~60% money out, all open),
 * written with one generate_series insert.
 *
 * What is measured (printed as "R-2685 measure …" and checked):
 *   1. the bank account page — time until the first line shows and until the main thread is quiet
 *      (no long task for 2 s), the longest task, and the sum of long tasks;
 *   2. search finds a line that is not on the first screen; the totals cover all 5,230 lines;
 *   3. /accounting/banking and /invoices — the same long-task numbers.
 * doneWhen: interactive < 3 s, no single main-thread block > 1 s. Numbers are for the local dev server
 * (React development build), which is slower than staging's production build.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, pageAs } from "./card-steps";

const ACCT = "c2685000-0000-4000-8000-000000000a01";
const N = 5230;

const CLEAN = `
  delete from public.bank_transactions where bank_account_id = '${ACCT}';
  delete from public.bank_accounts where id = '${ACCT}';`;

function seed(): void {
  const db = localDb("R-2685");
  db.psql(`
    begin;
    ${CLEAN}
    insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance, opening_balance_date)
      select '${ACCT}', ${E2E_TENANT_SQL}, 'CT R2685 HDFC', 'HDFC Bank', '2685', 2500000, date '2025-04-01';
    insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
      select ${E2E_TENANT_SQL}, '${ACCT}',
             date '2025-04-01' + (g * 560 / ${N}),
             case g % 5
               when 0 then 'UPI-SHARMA TRADERS ' || g || '-' || (g * 7919 % 100000) || '@okhdfcbank-PAYMENT CT R2685'
               when 1 then 'NEFT CR-ICIC0000' || (g % 50) || '-GUPTA INFOTECH ' || (g % 300) || '-INV ' || g || ' CT R2685'
               when 2 then 'SALARY ' || (array['JAN','FEB','MAR','APR'])[1 + g % 4] || ' VERMA KUMAR ' || (g % 40) || ' CT R2685'
               when 3 then 'IMPS-' || (g * 104729) || '-AGARWAL MEDIA ' || (g % 200) || ' CT R2685'
               else 'POS ' || (g * 31) || 'XXXXXX STORE ' || (g % 999) || ' CT R2685'
             end,
             case when g % 2 = 0 then 'REF' || g else null end,
             case when g % 5 in (1, 3) then 0 else 100 + (g * 7919 % 40000) end,
             case when g % 5 in (1, 3) then 100 + (g * 6007 % 40000) else 0 end,
             'csv_upload'
        from generate_series(1, ${N}) g;
    commit;`);
}

type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[];
  startTime: number; endTime: number; samples?: number[];
};
/** Where the CPU time went: the top functions by self time (ms), from a CDP CPU profile. */
function topSelfTime(p: CpuProfile, n = 15): string {
  const total = p.samples?.length ?? 0;
  const msPer = total ? (p.endTime - p.startTime) / 1000 / total : 0;
  const by = new Map<string, number>();
  for (const node of p.nodes) {
    const f = node.callFrame;
    if (!node.hitCount || f.functionName === "(idle)" || f.functionName === "(program)") continue;
    const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()?.split("?")[0] ?? ""}:${f.lineNumber}`;
    by.set(k, (by.get(k) ?? 0) + node.hitCount * msPer);
  }
  const self = [...by].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v)}ms ${k}`).join(" | ");
  /* Inclusive time of the app's own functions (src_ chunks): which component / helper the time sits under. */
  const kids = new Map<number, number[]>();
  for (const node of p.nodes as (CpuProfile["nodes"][number] & { children?: number[] })[]) kids.set(node.id, node.children ?? []);
  const byId = new Map(p.nodes.map((x) => [x.id, x]));
  const incl = new Map<string, number>();
  const walk = (id: number, open: Set<string>): number => {
    const node = byId.get(id);
    if (!node) return 0;
    const f = node.callFrame;
    const key = /src_/.test(f.url) && f.functionName ? `${f.functionName}` : null;
    const fresh = key !== null && !open.has(key);
    if (fresh) open.add(key);
    let t = (node.hitCount ?? 0) * msPer;
    for (const c of kids.get(id) ?? []) t += walk(c, open);
    if (fresh) { open.delete(key); incl.set(key, (incl.get(key) ?? 0) + t); }
    return t;
  };
  walk(p.nodes[0].id, new Set());
  const inclusive = [...incl].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v)}ms ${k}`).join(" | ");
  return `SELF: ${self} || INCLUSIVE (app code): ${inclusive}`;
}

const note = (what: string, m: Measure) =>
  test.info().annotations.push({ type: "measure", description: `${what}: first row ${m.firstRowMs} ms, quiet ${m.quietMs} ms, longest task ${m.longestMs} ms, long tasks ${m.tasks} = ${m.longSumMs} ms` });

type Measure = { firstRowMs: number; quietMs: number; longestMs: number; longSumMs: number; tasks: number };

/** Long tasks from navigation start; "quiet" = the end of the last long task before 2 s with none. */
async function measure(page: Page, path: string, ready: string): Promise<Measure> {
  await page.addInitScript(() => {
    const w = window as unknown as { __lt: { start: number; dur: number }[] };
    w.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt.push({ start: e.startTime, dur: e.duration }); })
      .observe({ type: "longtask", buffered: true });
  });
  await page.goto(path);
  await expect(page.locator(ready).first()).toBeVisible({ timeout: 120_000 });
  const firstRowMs = await page.evaluate(() => performance.now());
  // Wait until 2 s pass with no new long task (max 120 s).
  let last = -1;
  for (let i = 0; i < 120; i++) {
    const n = await page.evaluate(() => (window as unknown as { __lt: unknown[] }).__lt.length);
    if (n === last) break;
    last = n;
    await page.waitForTimeout(2000);
  }
  return page.evaluate((fr) => {
    const lt = (window as unknown as { __lt: { start: number; dur: number }[] }).__lt;
    const end = lt.reduce((m, e) => Math.max(m, e.start + e.dur), 0);
    return {
      firstRowMs: Math.round(fr), quietMs: Math.round(Math.max(fr, end)),
      longestMs: Math.round(lt.reduce((m, e) => Math.max(m, e.dur), 0)),
      longSumMs: Math.round(lt.reduce((s, e) => s + e.dur, 0)), tasks: lt.length,
    };
  }, firstRowMs);
}

test.describe("R-2685 card test", () => {
  onlyInCardTests();
  test.setTimeout(300_000);

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
    // Warm the dev server's compile of the page once, so the measure is the page, not Turbopack.
    await page.goto(`/accounting/banking/${ACCT}`);
    await expect(page.locator("tr[data-txn-id]").first()).toBeVisible({ timeout: 180_000 });
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb("R-2685").psql(`begin; ${CLEAN} commit;`);
  });

  test("Step 1: the 5,230-line bank page is usable in < 3 s, no main-thread block > 1 s", async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    await cdp.send("Profiler.start");
    const m = await measure(page, `/accounting/banking/${ACCT}`, "tr[data-txn-id]");
    const { profile } = await cdp.send("Profiler.stop");
    note(`bank page ${N} lines`, m);
    test.info().annotations.push({ type: "profile", description: topSelfTime(profile) });
    expect.soft(m.longestMs, "longest main-thread block").toBeLessThan(1000);
    expect.soft(m.quietMs, "interactive (quiet) time").toBeLessThan(3000);
  });

  test("Step 2: search finds a line far down the list; totals cover every line", async () => {
    await expect(page.getByText(`${N.toLocaleString("en-IN")}`).first()).toBeVisible();
    const search = page.getByPlaceholder(/search/i).first();
    await search.fill("INV 5226");
    await expect(page.locator("tr[data-txn-id]").filter({ hasText: "INV 5226 CT R2685" })).toBeVisible({ timeout: 20_000 });
    await search.fill("");
  });

  test("Step 3: /accounting/banking and /invoices open without a long freeze", async () => {
    const b = await measure(page, "/accounting/banking", "text=CT R2685 HDFC");
    note("/accounting/banking", b);
    const inv = await measure(page, "/invoices", "h1");
    note("/invoices", inv);
    expect.soft(b.longestMs).toBeLessThan(1000);
    expect.soft(inv.longestMs).toBeLessThan(1000);
  });
});
