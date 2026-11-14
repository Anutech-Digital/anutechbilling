/**
 * Card test — R-2751 "Renewals: one amount basis everywhere — opening a quote must not flip a row to
 * 'incl. GST' or raise the Due tile; forecast month = tile month" (14 Nov user audit, job 7).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2751`. Nothing is sent or saved by the app: the draft renewal
 * quote is planted in the local DB exactly as "Review renewal quote" leaves it (status draft, linked).
 *
 * Data (local docker DB, E2E Test Co, fixed ids, removed before and after):
 *   · "CT R2751 Kochi Hosting" — ₹21,600 a year (mrr 1,800), renews in 20 days (8–30 tab, Due in 30 days tile);
 *   · step 2 links a DRAFT renewal quote Q-CT2751-REN (₹25,488 incl. GST, subtotal ₹21,600).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2751000-0000-4000-8000-000000000001";
const SUB = "c2751000-0000-4000-8000-000000000021";
/* due later THIS month, so "Renewed this month" has a figure to compare with the Forecast (step 3) */
const SUB_MONTH = "c2751000-0000-4000-8000-000000000022";
const QUOTE = "Q-CT2751-REN";
const NAME = "CT R2751 Kochi Hosting";
const db = () => localDb("R-2751");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set renewal_quote_id = null where id = '${SUB}' and tenant_id = ${T};
    delete from public.quotes where id = '${QUOTE}' and tenant_id = ${T};
    delete from public.subscriptions where id in ('${SUB}', '${SUB_MONTH}') and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2751-kochi@example.test', '32', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, term_amount, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', 'CT R2751 Hosting', 'google', 1, 1800, 12, 21600, 'yearly',
              public.ist_today() - 345, public.ist_today() + 20, 'active', 'pending', true, 0),
             ('${SUB_MONTH}', ${T}, '${CUST}', '${NAME}', 'CT R2751 Mail', 'google', 1, 500, 12, 6000, 'yearly',
              public.ist_today() - 360,
              least(public.ist_today() + 1, (date_trunc('month', public.ist_today()) + interval '1 month - 1 day')::date),
              'active', 'pending', true, 0);
    commit;`);
}

/** What "Review renewal quote" leaves behind: a DRAFT renewal quote, linked to the subscription. */
function linkDraftQuote(): void {
  db().psql(`begin;
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               created_date, expires_date, amount, subtotal, tax_rate, line_items, notes)
      values ('${QUOTE}', ${T}, '${CUST}', '${NAME}', 'draft', 'none', true, '${SUB}',
              public.ist_today(), public.ist_today() + 15, 25488, 21600, 18, '[]', 'Renewal for subscription ${SUB}');
    update public.subscriptions set renewal_quote_id = '${QUOTE}' where id = '${SUB}' and tenant_id = ${T};
    commit;`);
}

const kochiRow = (page: Page) => page.locator("tr", { hasText: NAME }).filter({ hasText: "CT R2751 Hosting" }).filter({ visible: true });

async function openRenewals(page: Page): Promise<void> {
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(kochiRow(page)).toHaveCount(1, { timeout: 60_000 });
}

/** The Due in 30 days tile's full ₹ (from its title: "Due in 30 days: ₹39,900 — 4 renewals. …"). */
async function due30Title(page: Page): Promise<string> {
  const tile = await onlyOne(page.getByRole("button", { name: /^Due in 30 days/ }), "Due in 30 days tile");
  const title = (await tile.getAttribute("title")) ?? "";
  expect(title).toMatch(/^Due in 30 days: ₹[\d,]+ — \d+ renewals?\./);
  return title;
}

test.describe("R-2751 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: 8–30 tab — the Kochi row reads ₹21,600/yr + GST; the Due in 30 days tile has a figure", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1568, height: 900 });
    await openRenewals(page);
    const row = kochiRow(page);
    await expect(row).toContainText("₹21,600/yr");
    await expect(row).toContainText("+ GST");
    await expect(row).not.toContainText("incl. GST");
    await due30Title(page);
    await page.close();
  });

  test("Step 2: a DRAFT renewal quote (Review renewal quote, nothing sent) changes neither the row nor the tile", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1568, height: 900 });
    await openRenewals(page);
    /* read the tile, make the draft, reload at once: other card tests share this local DB, so the window is kept short */
    const before = await due30Title(page);
    linkDraftQuote();
    await page.reload();
    await expect(kochiRow(page)).toHaveCount(1, { timeout: 60_000 });
    const row = kochiRow(page);
    await expect(row).toContainText("₹21,600/yr");
    await expect(row).toContainText("+ GST");
    await expect(row).not.toContainText("incl. GST");
    await expect(row).not.toContainText("25,488");
    await expect.poll(() => due30Title(page), { timeout: 30_000 }).toBe(before);
    await page.close();
  });

  test("Step 3: Forecast > Expand — this month's bar is the Renewed this month tile's 'of ₹X due in <month>'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1568, height: 900 });
    await openRenewals(page);
    const renewed = await onlyOne(page.getByRole("button", { name: /^Renewed this month/ }), "Renewed this month tile");
    await expect(renewed).toHaveAttribute("title", /% of ₹[^ ]+ due in \w{3}/, { timeout: 60_000 });
    const m = ((await renewed.getAttribute("title")) ?? "").match(/% of (₹[^ ]+) due in (\w{3})/)!;
    const [, dueText, mon] = m;
    const toggle = await onlyOne(page.locator('[data-kpi-strip="renewals"] button[aria-expanded]'), "Forecast strip toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const bar = await onlyOne(page.locator(`[data-kpi-strip="renewals"] [title^="${mon} "]`), `Forecast ${mon} bar`);
    const col = bar.locator("xpath=ancestor::div[contains(@class,'text-center')][1]");
    await expect(col).toContainText(dueText);
    await page.close();
  });
});
