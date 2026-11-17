/**
 * Card test — R-2887 "Renewals row shows the commitment" (Pardeep 17 Nov: "renewal monthly hai ya yearly ye bhi
 * renewal list me show hona chahiye"). A REAL browser measure on the LOCAL app (E2E Test Co, owner login).
 * Run: `node scripts/ops/card-tests.mjs R-2887` (R2887_KEEP=1 leaves the rows to look at by hand).
 * Data (fresh every run, fixed ids, removed after): one customer, three Google subscriptions due 5 days ago —
 *   monthly flexible (term 1, billed monthly), yearly (term 12, billed yearly), annual paid monthly (term 12, billed monthly).
 */
import { appendFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2887000-0000-4000-8000-000000000001";
const NAME = "CT R2887 Commitment Traders";
const SUB = { M: "c2887000-0000-4000-8000-000000000021", Y: "c2887000-0000-4000-8000-000000000022", P: "c2887000-0000-4000-8000-000000000023" };
const PLAN = { M: "CT R2887 Monthly Plan", Y: "CT R2887 Yearly Plan", P: "CT R2887 Paid Monthly Plan" };
const WANT = { M: "Flexible (monthly)", Y: "Annual · paid yearly", P: "Annual · paid monthly" };
const db = () => localDb("R-2887");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    delete from public.subscriptions where id in ('${SUB.M}', '${SUB.Y}', '${SUB.P}') and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  const sub = (id: string, plan: string, mrr: number, term: number, cycle: string) =>
    `('${id}', ${T}, '${CUST}', '${NAME}', '${plan}', 'google', 5, ${mrr}, ${term}, '${cycle}',
      public.ist_today() - ${term === 1 ? 35 : 370}, public.ist_today() - 5, 'active', 'notice_sent', true)`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'accounts@ct2887.test', '+91 98765 28871', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ${sub(SUB.M, PLAN.M, 6500, 1, "monthly")}, ${sub(SUB.Y, PLAN.Y, 6500, 12, "yearly")}, ${sub(SUB.P, PLAN.P, 6500, 12, "monthly")};
    commit;`);
}

const row = (page: Page, plan: string) => page.locator("tr", { hasText: plan }).filter({ visible: true });

async function openAt(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  for (let attempt = 1; ; attempt++) {
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await expect(table).toBeVisible({ timeout: 90_000 });
    await expect(row(page, PLAN.M)).toHaveCount(1, { timeout: 90_000 });
    await expect(table.getByTestId("renewal-row-quote").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
    await expect(table.getByTestId("stage-chip-loading")).toHaveCount(0, { timeout: 90_000 });
    if (!(await table.getByText(/couldn.t load/).count())) return;
    if (attempt >= 3) throw new Error(`a row read failed ${attempt}x on this server (local Supabase load)`);
  }
}

test.describe("R-2887 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 480_000 });
  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON && process.env.R2887_KEEP !== "1") clean(); });

  test("Step 1: at 1280×720 every row shows Monthly or Yearly next to the plan, and the row stays ≤ 76px", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1280, 720);
    for (const k of ["M", "Y", "P"] as const) {
      const chip = row(page, PLAN[k]).getByTestId("renewal-commitment");
      await expect(chip).toHaveText(WANT[k]);
      await expect(chip).toHaveAttribute("title", /commitment/);
    }
    /* The chip must not make the row taller: the Product cell is the same height on all three rows (the chip sits on
       the plan line), and a row that is not part-billed stays <= 76px (R-2759 / R-2880). Part-billed rows are taller
       from their Status cell ("Part not billed (Nov)" + "Hold at Google — unpaid +1") — that is R-2880's, measured
       the same with and without the chip. */
    const m = await page.evaluate((plans) => plans.map((p) => {
      const tr = [...document.querySelectorAll("tbody tr")].find((r) => (r as HTMLElement).innerText.includes(p))!;
      return { row: Math.round(tr.getBoundingClientRect().height), product: Math.round((tr.querySelector('[data-cell="product"]') as HTMLElement).getBoundingClientRect().height) };
    }), [PLAN.M, PLAN.Y, PLAN.P]);
    test.info().annotations.push({ type: "measured", description: `1280x720 row/product heights ${JSON.stringify(m)}` });
    if (process.env.R2887_OUT) appendFileSync(process.env.R2887_OUT, `1280x720 ${JSON.stringify(m)}
`);
    expect(m[1].row, "yearly row height").toBeLessThanOrEqual(76);
    for (const x of m) expect(x.product, "Product cell, with the chip").toBeLessThanOrEqual(m[1].product + 1);
    const spill = await page.evaluate(() => (document.querySelector('[data-testid="renewals-table"]') as HTMLElement).scrollWidth <= (document.querySelector('[data-testid="renewals-table"]') as HTMLElement).clientWidth + 1);
    expect(spill, "table not wider than its box").toBe(true);
    await page.context().close();
  });

  test("Step 2: the Commitment filter agrees with the chip — 'Monthly (flex)' keeps the monthly row, 'Annual' keeps the yearly ones", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAt(page, 1280, 720);
    await page.getByLabel("Filter by commitment").selectOption("monthly");
    await expect(row(page, PLAN.M)).toHaveCount(1);
    await expect(row(page, PLAN.Y)).toHaveCount(0);
    await page.getByLabel("Filter by commitment").selectOption("annual");
    await expect(row(page, PLAN.Y)).toHaveCount(1);
    await expect(row(page, PLAN.P)).toHaveCount(1);
    await expect(row(page, PLAN.M)).toHaveCount(0);
    await page.context().close();
  });
});
