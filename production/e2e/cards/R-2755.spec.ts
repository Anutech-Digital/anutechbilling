/**
 * Card test — R-2755 "Renewals: show the subscription's domain on the row (table, card, drawer); an
 * empty tab after a search says 'N matches in <tab> — show'".
 * Run: `node scripts/ops/card-tests.mjs R-2755`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer
 * renewing in 12 days (tab 8–30) with two subscriptions —
 *   · A "CT R2755 Google Workspace Business Starter" on a LONG domain (must cut, full text on hover);
 *   · B "CT R2755 Short Plan" on "ct2755.in".
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2755000-0000-4000-8000-000000000001";
const SUB_A = "c2755000-0000-4000-8000-000000000021";
const SUB_B = "c2755000-0000-4000-8000-000000000022";
const NAME = "CT R2755 Domain Customer";
const PLAN_A = "CT R2755 Google Workspace Business Starter";
const PLAN_B = "CT R2755 Short Plan";
const LONG_DOMAIN = "ct2755-a-very-long-subdomain-for-the-renewals-row.example.co.in";
const SHORT_DOMAIN = "ct2755.in";
const db = () => localDb("R-2755");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    delete from public.subscriptions where id in ('${SUB_A}', '${SUB_B}') and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'billing@ct2755.in', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', '${PLAN_A}', 'google', 25, 4000, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, '${LONG_DOMAIN}'),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', '${PLAN_B}', 'google', 3, 500, 12, 'yearly',
              public.ist_today() - 353, public.ist_today() + 12, 'active', 'notice_sent', true, '${SHORT_DOMAIN}');
    commit;`);
}

async function search(page: Page): Promise<void> {
  const box = page.getByRole("searchbox", { name: "Search renewals by customer or domain" });
  await expect(box).toBeVisible({ timeout: 90_000 });
  await box.fill("ct2755");
  await expect(box).toHaveValue("ct2755");
}

const rowOf = (page: Page, plan: string) => page.getByTestId("renewals-table").locator("tr", { hasText: plan });

async function openD30(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(page.getByTestId("renewals-table")).toBeVisible({ timeout: 60_000 });
  await search(page);
  await expect(rowOf(page, PLAN_A)).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("renewals-table").getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 60_000 });
}

async function domainShownAndFits(page: Page): Promise<void> {
  const dA = rowOf(page, PLAN_A).getByTestId("renewal-row-domain");
  await expect(dA).toBeVisible();
  await expect(dA).toHaveAttribute("title", LONG_DOMAIN);
  const dB = rowOf(page, PLAN_B).getByTestId("renewal-row-domain");
  await expect(dB).toHaveText(SHORT_DOMAIN);
  const m = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="renewals-table"]') as HTMLElement;
    return {
      scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
      tableScroll: table.scrollWidth, tableBox: table.clientWidth,
      maxRight: Math.max(...[...table.querySelectorAll("tbody tr td:last-child")].map((td) => td.getBoundingClientRect().right)),
      overflowing: [...table.querySelectorAll("tbody td")].filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => (td as HTMLElement).innerText.slice(0, 40)),
    };
  });
  expect(m.scroll, "page has no horizontal scroll").toBeLessThanOrEqual(m.inner);
  expect(m.tableScroll, "the table is not wider than its box").toBeLessThanOrEqual(m.tableBox + 1);
  expect(m.maxRight, "Action column inside the viewport").toBeLessThanOrEqual(m.inner);
  expect(m.overflowing, "cells spilling into the next column").toEqual([]);
  /* two lines a cell still (R-2759's 76px row) */
  for (const plan of [PLAN_A, PLAN_B]) {
    const h = await rowOf(page, plan).evaluate((tr) => tr.getBoundingClientRect().height);
    expect(h, `${plan} row height`).toBeLessThanOrEqual(76);
  }
}

test.describe("R-2755 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Overdue tab, search 'ct2755' → '2 matches in 8–30 — show'; pressing it opens 8–30 with both rows", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    await search(page);
    const elsewhere = page.getByTestId("renewals-matches-elsewhere");
    await expect(elsewhere).toBeVisible({ timeout: 60_000 });
    const show = elsewhere.getByRole("button", { name: "2 matches in 8–30 — show" });
    await expect(show).toBeVisible();
    await show.click();
    await expect(page).toHaveURL(/bucket=d30/);
    await expect(page.getByText(PLAN_A).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(PLAN_B).filter({ visible: true }).first()).toBeVisible();
    await page.context().close();
  });

  test("Step 2: at 1276×800 each row shows its domain (long one cut, full on hover); no horizontal scroll, two-line rows", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openD30(page, 1276, 800);
    await domainShownAndFits(page);
    await page.context().close();
  });

  test("Step 3: at 1568×900 the same — domain shown, table fits", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openD30(page, 1568, 900);
    await domainShownAndFits(page);
    await page.context().close();
  });

  test("Step 4: the row drawer's header names the domain; the card list (narrow window) shows it too", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openD30(page, 1568, 900);
    await rowOf(page, PLAN_B).getByTestId("renewal-open-drawer").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(new RegExp(`${PLAN_B}.*${SHORT_DOMAIN.replace(".", "\\.")}`))).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1000, height: 900 });
    const cards = page.getByTestId("renewals-cards");
    await expect(cards).toBeVisible({ timeout: 30_000 });
    await expect(cards.getByTestId("renewal-card-domain").filter({ hasText: SHORT_DOMAIN })).toHaveCount(1);
    await page.context().close();
  });
});
