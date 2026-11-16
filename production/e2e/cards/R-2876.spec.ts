/**
 * Card test — R-2876: the Renewals page's Status / Last bill come from ONE read (public.renewal_row_facts) and show
 * exactly what the old four-trip reads showed.
 * Run: `node scripts/ops/card-tests.mjs R-2876` (E2E Test Co, local docker DB only — this spec only READS).
 *
 * Step 1: on every Renewals tab the page asks the one read and none of the old trips (no billing-part / credit-note read).
 * Step 2: the same tabs with the one read switched OFF in the browser (answered "function not found", as on a server
 *         deployed before its DB step) — the page falls back to the old reads, and EVERY row reads word for word the same
 *         as in step 1: Status, Last bill, the action button, tooltips. This is the old-vs-new equality on the real local data.
 * Step 3: tenant isolation through the browser's own request — the page's one read is repeated with ANOTHER company's
 *         subscription and quote ids added (and with only those ids): nothing of that company comes back.
 * Each step prints `R-2876 timing …` lines: table shown → every Status / Last bill filled, and `readers=` — the two readers'
 * own requests from the first one sent to the last one answered (the wait this card shortens; the rest is the page itself).
 * NOTE: the localhost server runs reselleros-deploy's build; step 1 passes only once that build contains the R-2876 code
 * and the local DB has the function (npm run localhost:update applies the migration).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const TABS = ["overdue", "due7", "d30", "d60", "d90", "later"] as const;
const RPC = /\/rest\/v1\/rpc\/renewal_row_facts/;
/** Reads only the OLD way makes on this page: the billing parts BY SUBSCRIPTION and the notes BY INVOICE
    (another panel reads a few billing parts by their own id — not one of the four trips). */
const OLD_ONLY = /\/rest\/v1\/(subscription_billings\?.*[?&]subscription_id=in\.|(credit_notes|debit_notes)\?.*[?&]invoice_id=in\.)/;

/** Every request of the two readers (Last docs, Last paid), old way or new — "the chain" Status / Last bill wait for. */
const CHAIN_PARTS = [
  /\/rest\/v1\/rpc\/renewal_row_facts/,
  /\/rest\/v1\/quotes\?.*[?&](renewal_subscription_id|add_seats_subscription_id|subscription_billing_id)=in\./,
  /\/rest\/v1\/quotes\?select=id%2Cline_items/,
  /\/rest\/v1\/(subscription_billings|renewal_quote_subscriptions)\?.*[?&]subscription_id=in\./,
  /\/rest\/v1\/invoices\?.*[?&](quote_id|id)=in\./,
  /\/rest\/v1\/(credit_notes|debit_notes)\?.*[?&]invoice_id=in\./,
  /\/rest\/v1\/payments\?.*[?&](quote_id|invoice_id)=in\./,
  /\/rest\/v1\/subscriptions\?.*[?&]quote_id=in\./,
];
const CHAIN = { test: (url: string) => CHAIN_PARTS.some((re) => re.test(url)) };

interface TabRead {
  tab: string; rows: string[]; tableMs: number; filledMs: number; rpc: number; old: number;
  /** first request of the readers → their last answer (ms), and how many requests that was */
  chainMs: number; chainRequests: number;
  /** why the page left the one read, and which old reads it made */
  notes: string[];
}

/** Open one tab; wait until the table shows and nothing in a row is still loading; return every row's words. */
async function readTab(page: Page, tab: string): Promise<TabRead> {
  let rpc = 0; let old = 0; let chainRequests = 0; let first = 0; let last = 0;
  const notes: string[] = [];
  const onRequest = (r: { url(): string }) => {
    if (RPC.test(r.url())) rpc += 1;
    if (OLD_ONLY.test(r.url())) { old += 1; notes.push(`old read: ${r.url().split("/rest/v1/")[1].slice(0, 120)}`); }
    if (CHAIN.test(r.url())) { chainRequests += 1; if (!first) first = Date.now(); }
  };
  const onDone = (r: { url(): string }) => { if (CHAIN.test(r.url())) last = Date.now(); };
  const onConsole = (m: { text(): string }) => { if (m.text().includes("R-2876")) notes.push(m.text().slice(0, 300)); };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  page.on("console", onConsole);
  const t0 = Date.now();
  await page.goto(`/renewals?bucket=${tab}`);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: /Renewals/ }).first()).toBeVisible({ timeout: 120_000 });
  const rows = page.getByTestId("renewal-row");
  /* the tab's rows, or its empty state */
  await expect(async () => {
    expect((await rows.count()) > 0 || (await page.getByText(/No renewals|Nothing|No subscriptions/i).count()) > 0).toBe(true);
  }).toPass({ timeout: 120_000 });
  const tableMs = Date.now() - t0;
  /* filled = no row still says it is loading (Status / next-step button, Last bill, Last paid "…") */
  await expect(rows.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 120_000 });
  await expect(rows.getByTestId("last-invoice-loading")).toHaveCount(0, { timeout: 120_000 });
  await expect(rows.getByTestId("renewal-row-last-paid").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 120_000 });
  const filledMs = Date.now() - t0;
  /* the rest of the row (contact, follow-up — other reads) settles too: quiet network, then the same words twice in a row */
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => { /* a polling page never goes idle */ });
  const capture = () => rows.evaluateAll((trs) => trs.map((tr) => {
    const titles = [...tr.querySelectorAll("[title]")].map((el) => el.getAttribute("title")).join(" | ");
    return `${(tr as HTMLElement).innerText.replace(/\s+/g, " ").trim()} ## ${titles}`;
  }));
  let words = await capture();
  await expect(async () => {
    await page.waitForTimeout(1_000);
    const again = await capture();
    const same = JSON.stringify(again) === JSON.stringify(words);
    words = again;
    expect(same, "rows still changing").toBe(true);
  }).toPass({ timeout: 60_000 });
  page.off("request", onRequest);
  page.off("requestfinished", onDone);
  page.off("requestfailed", onDone);
  page.off("console", onConsole);
  return { tab, rows: words, tableMs, filledMs, rpc, old, chainMs: first && last ? last - first : 0, chainRequests, notes };
}

const say = (label: string, reads: TabRead[]) => {
  for (const r of reads) {
    console.log(`R-2876 timing ${label} tab=${r.tab} rows=${r.rows.length} table=${r.tableMs}ms filled=${r.filledMs}ms afterTable=${r.filledMs - r.tableMs}ms readers=${r.chainMs}ms in ${r.chainRequests} requests rpc=${r.rpc} oldReads=${r.old}`);
  }
};

test.describe("R-2876 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  let oneRead: TabRead[] = [];

  test("Step 1: every Renewals tab fills Status / Last bill from the ONE read — none of the old trips", async ({ browser, baseURL }) => {
    test.setTimeout(900_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/renewals", /Renewals/);   // warm the page (dev server compiles it on first open)
      for (const tab of TABS) oneRead.push(await readTab(page, tab));
      say("one-read", oneRead);
      const withRows = oneRead.filter((r) => r.rows.length > 0);
      expect(withRows.length, "E2E Test Co has renewals on at least one tab").toBeGreaterThan(0);
      for (const r of withRows) {
        expect(r.rpc, `${r.tab}: the one read was asked`).toBeGreaterThanOrEqual(1);
        expect(r.old, `${r.tab}: old trips (billing parts / credit notes) still made — ${r.notes.join(" ; ")}`).toBe(0);
        expect(r.rows.join("\n"), `${r.tab}: nothing left loading`).not.toMatch(/Loading…|couldn't load/);
      }
    } finally { await page.context().close(); }
  });

  test("Step 2: with the one read switched off the page falls back to the old reads — every row reads the same", async ({ browser, baseURL }) => {
    test.setTimeout(1_500_000);
    test.skip(oneRead.length === 0, "Step 1 did not run");
    const page = await pageAs(browser, baseURL, "owner");
    const missing = (route: Route) => route.fulfill({
      status: 404, contentType: "application/json",
      body: JSON.stringify({ code: "PGRST202", details: null, hint: null, message: "Could not find the function public.renewal_row_facts(p_quote_ids, p_sub_ids) in the schema cache" }),
    });
    try {
      await openAppPage(page, "/renewals", /Renewals/);
      /* The local database is shared: another card test may add / remove E2E Test Co rows while this runs. So each tab is
         read one-read → old reads → one-read again, back to back; the old reads are judged only against a one-read answer
         that was the same before and after them (up to 3 tries). */
      for (const tab of TABS.filter((t) => oneRead.find((r) => r.tab === t)!.rows.length > 0)) {
        let judged = false;
        for (let attempt = 1; attempt <= 3 && !judged; attempt += 1) {
          const before = await readTab(page, tab);
          await page.route(RPC, missing);
          const oldWay = await readTab(page, tab);
          await page.unroute(RPC, missing);
          const after = await readTab(page, tab);
          say(`pair-${attempt} one-read`, [before]); say(`pair-${attempt} old-reads`, [oldWay]); say(`pair-${attempt} one-read`, [after]);
          if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) continue;   // the data moved under us — read again
          judged = true;
          expect(before.old + after.old, `${tab}: the one read made old trips`).toBe(0);
          if (oldWay.rows.length > 0) expect(oldWay.old, `${tab}: the old reads ran`).toBeGreaterThan(0);
          expect(oldWay.rows.length, `${tab}: same number of rows`).toBe(before.rows.length);
          for (const [n, row] of oldWay.rows.entries()) expect(row, `${tab} row ${n + 1}: old reads vs one read`).toBe(before.rows[n]);
        }
        expect(judged, `${tab}: the local data kept changing during 3 tries (another test is writing E2E Test Co) — run again`).toBe(true);
      }
    } finally { await page.context().close(); }
  });

  test("Step 3: another company's ids added to the page's own read bring nothing back", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const tab = oneRead.find((r) => r.rows.length > 0)?.tab;
    test.skip(!tab, "Step 1 found no tab with rows");
    /* ids of subscriptions / quotes that belong to OTHER companies in the local database (read only) */
    const db = localDb("R-2876");
    const foreignSubs = db.psql(`select s.id from public.subscriptions s where s.tenant_id <> ${E2E_TENANT_SQL} order by s.id limit 25`);
    const foreignQuotes = db.psql(`select q.id from public.quotes q where q.tenant_id <> ${E2E_TENANT_SQL} order by q.id limit 25`);
    test.skip(foreignSubs.length === 0 || foreignQuotes.length === 0, "the local database has no other company with subscriptions and quotes");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      type Ask = { p_sub_ids: string[]; p_quote_ids: string[] };
      const seen = new Promise<{ own: Record<string, unknown[]>; mixed: Record<string, unknown[]>; onlyForeign: Record<string, unknown[]> }>((resolve, reject) => {
        void page.route(RPC, async (route: Route) => {
          try {
            const ask = route.request().postDataJSON() as Ask;
            const headers = route.request().headers();
            const again = async (body: Ask) => (await (await route.fetch({ postData: JSON.stringify(body), headers })).json()) as Record<string, unknown[]>;
            const ownRes = await route.fetch();
            const own = (await ownRes.json()) as Record<string, unknown[]>;
            const mixed = await again({ p_sub_ids: [...ask.p_sub_ids, ...foreignSubs], p_quote_ids: [...ask.p_quote_ids, ...foreignQuotes] });
            const onlyForeign = await again({ p_sub_ids: foreignSubs, p_quote_ids: foreignQuotes });
            await route.fulfill({ response: ownRes });
            resolve({ own, mixed, onlyForeign });
          } catch (e) { reject(e); await route.abort().catch(() => {}); }
        }, { times: 1 });
      });
      await page.goto(`/renewals?bucket=${tab}`);
      const { own, mixed, onlyForeign } = await seen;
      expect(own.quotes.length + own.billings.length, "the page's own read has rows (not an empty = empty check)").toBeGreaterThan(0);
      /* the same rows with the other company's ids added — nothing rode along */
      expect(mixed).toEqual(own);
      const text = JSON.stringify(mixed);
      for (const id of [...foreignSubs, ...foreignQuotes]) expect(text.includes(`"${id}"`), `another company's id ${id} in the answer`).toBe(false);
      /* only the other company's ids → every list empty */
      for (const [key, list] of Object.entries(onlyForeign)) expect(list, `${key} for another company's ids`).toEqual([]);
    } finally { await page.context().close(); }
  });
});
