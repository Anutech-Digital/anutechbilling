/**
 * Card test — R-2723 (R-2712 review leftovers; MONEY-ADJACENT, exact numbers): a subscription filed from a quote takes
 * ITS OWN quote line (not the next bulk line by counting), and the quote builder's Flexible switch drops the years.
 * Run: `node scripts/ops/card-tests.mjs R-2723`.
 *
 * Data: scenario "yearly-together" supplies the customer (SCN Yearly Pair Pvt Ltd, reloaded first, cleared after — the
 * clear also removes the quote, the subscriptions and the invoice this spec makes for that customer). The one quote
 * Q-SCN-R2723-1 is planted by SQL (fixed id, E2E Test Co, deleted first so a crashed run does not block the next), as
 * the card's own SQL test does — shape (a): ONE plan on two lines:
 *   line 1  "SCN R2723 Plan" × 1 at ₹1,000, NO commitment (a normal line);
 *   line 2  the same plan, "Bulk / many domains", 2 domains × ₹2,400 for 3 years (₹800 a year each), annual commitment.
 * Everything after that is pressed in the app: Quotes → Activate now, pay later (owner override for the annual line) →
 * Subscriptions. Step 3 opens the builder on the same customer and switches a 3-year ₹2,400 domain line to Flexible.
 *
 * Exact numbers (from supabase/tests/r2723_quote_line_pick.test.sql case a): the normal row = 1 year · mrr 83 ·
 * ₹1,000.00; each bulk row = renews 3 years on · mrr 67 · ₹800.00 a year. Flexible: ₹2,400 / 3 yrs → ₹67 a month, no years.
 * SQL here only READS (plus planting / removing the one quote and one catalogue item with fixed ids).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUST = "c2850000-0000-4000-8000-000000000001";
const CUST_NAME = "SCN Yearly Pair Pvt Ltd";
const QUOTE = "Q-SCN-R2723-1";
const PLAN = "SCN R2723 Plan";
const DOM_A = "r2723-a.in";
const DOM_B = "r2723-b.in";
const ITEM_ID = "SCN-R2723-DOMAIN-IN";
const ITEM = "SCN R2723 Domain .in";
const db = () => localDb("R-2723");
const T = E2E_TENANT_SQL;

function scenario(flag: "--reset" | "--clear"): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "yearly-together", flag], { cwd: prod, encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`scenario yearly-together ${flag} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

/** Plant the one accepted quote (shape a) + a per-year domain catalogue item; both fixed ids, E2E Test Co only. */
function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  db().psql(`
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices, item_type, is_active)
select '${ITEM_ID}', ${T}, '${ITEM}', 'domain', 800, 600, '{"billing_unit":"unit_year"}'::jsonb, 'subscription', true
 where not exists (select 1 from public.items where id = '${ITEM_ID}');
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate, discount_pct,
                           status, payment_status, billing_cycle, currency, created_date, expires_date, line_items)
select '${QUOTE}', ${T}, '${CUST}', '${CUST_NAME}', '${PLAN}', 3, 6844, 5800, 0, 18, 0,
       'accepted', 'awaiting', 'yearly', 'INR', public.ist_today(), public.ist_today() + 30,
       jsonb_build_array(
         jsonb_build_object('id', 'line-1', 'name', '${PLAN}', 'qty', 1, 'rate', 1000, 'cost', 0, 'start_date', to_char(public.ist_today(), 'YYYY-MM-DD')),
         jsonb_build_object('id', 'line-2', 'name', '${PLAN}', 'qty', 2, 'rate', 2400, 'cost', 0, 'commitment', 'annual_yearly', 'bulk', true, 'years', 3,
                            'start_date', to_char(public.ist_today(), 'YYYY-MM-DD'),
                            'domains', jsonb_build_array(jsonb_build_object('domain', '${DOM_A}', 'seats', 1), jsonb_build_object('domain', '${DOM_B}', 'seats', 1))))
 where not exists (select 1 from public.quotes where id = '${QUOTE}');
`);
}
/** Remove this spec's fixed-id catalogue item (the quote goes with the scenario clear). */
function unplantItem(): void {
  db().psql(`delete from public.items where id = '${ITEM_ID}' and tenant_id = ${T};`);
}

/** One row per subscription of the quote: "domain|renewal date|term_months|mrr|term_amount|start date" (domain '-' = none). */
function rows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of db().psql(`select coalesce(domain, '-') || '|' || renewal_date || '|' || term_months || '|' || mrr || '|' || coalesce(term_amount::text, 'null') || '|' || start_date
                               from public.subscriptions where tenant_id = ${T} and quote_id = '${QUOTE}' order by domain nulls first`)) {
    out[l.split("|")[0]] = l;
  }
  return out;
}
const istPlus = (interval: string): string => db().one(`select (public.ist_today() + interval '${interval}')::date`);

async function openQuote(page: Page): Promise<void> {
  await openAppPage(page, `/quotes/${encodeURIComponent(QUOTE)}`);
  await expect(page.getByTestId("quote-for-subscription")).toHaveCount(0);   // a sale quote, not a renewal
}

test.describe("R-2723 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    scenario("--reset");
    plant();
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON) return;
    scenario("--clear");
    unplantItem();
  });

  test("Step 1: Quotes → Activate now, pay later (owner override) → ONE plan on two lines: the normal row keeps ITS line (1 year · ₹1,000), each bulk domain its 3 years", async ({ browser, baseURL }) => {
    test.setTimeout(420_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openQuote(page);
      const activate = page.getByRole("button", { name: "Activate now, pay later" }).first();
      await expect(activate).toBeVisible({ timeout: 90_000 });
      await activate.click();
      const sheet = page.getByRole("dialog", { name: /Activate now, pay later/ });
      await expect(sheet).toBeVisible({ timeout: 60_000 });
      /* an annual line needs the owner's override + a reason (R-368) */
      await sheet.getByText("Override as owner.").click();
      await sheet.locator("#credit-annual-reason").fill("R-2723 card test — checking which quote line each subscription takes");
      const go = sheet.getByRole("button", { name: "Activate on credit" });
      await expect(go).toBeEnabled({ timeout: 30_000 });
      await go.click();
      await expect(sheet).toBeHidden({ timeout: 120_000 });

      const r = rows();
      expect(Object.keys(r).sort(), "three subscriptions: the normal one + one per bulk domain").toEqual(["-", DOM_A, DOM_B].sort());
      const start = istPlus("0 days");
      /* normal line: no commitment, ₹1,000 → renews ONE year on, mrr 83, ₹1,000.00 — not the bulk line's 3 years */
      expect(r["-"], "normal row").toBe(`-|${istPlus("1 year")}|12|83|1000.00|${start}`);
      /* bulk line: 3 years, ₹2,400 over 3 years = ₹800.00 a year each, mrr 67 */
      expect(r[DOM_A], "bulk row A").toBe(`${DOM_A}|${istPlus("3 years")}|12|67|800.00|${start}`);
      expect(r[DOM_B], "bulk row B").toBe(`${DOM_B}|${istPlus("3 years")}|12|67|800.00|${start}`);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Subscriptions shows each row with its own date and amount", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    test.skip(Object.keys(rows()).length !== 3, "needs Step 1's three subscriptions");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAppPage(page, "/subscriptions", /^Subscriptions$/);
      const search = page.getByPlaceholder(/Customer, contact, plan, domain/);
      await expect(search).toBeVisible({ timeout: 90_000 });
      await search.fill(PLAN);
      const planRows = page.locator("tr").filter({ hasText: PLAN });
      await expect(planRows).toHaveCount(3, { timeout: 90_000 });
      const fmt = (interval: string): string => db().one(`select to_char((public.ist_today() + interval '${interval}')::date, 'FMDD Mon YYYY')`);
      const started = fmt("0 days");
      /* the normal row: its own line — ₹1,000 a year, mrr ₹83, renews ONE year on (not the bulk line's 3 years) */
      const normal = await onlyOne(planRows.filter({ hasNotText: "r2723-" }), "the normal row (no domain)");
      await expect(normal).toContainText("Annual · paid yearly · ₹1,000");
      await expect(normal).toContainText("₹83");
      await expect(normal).toContainText(fmt("1 year"));
      await expect(normal).toContainText(`Started ${started}`);
      await expect(normal).not.toContainText(fmt("3 years"));
      /* each bulk domain row: ₹800 a year, mrr ₹67, renews 3 years on */
      for (const dom of [DOM_A, DOM_B]) {
        const row = await onlyOne(planRows.filter({ hasText: dom }), `the ${dom} row`);
        await expect(row).toContainText("Annual · paid yearly · ₹800");
        await expect(row).toContainText("₹67");
        await expect(row).toContainText(fmt("3 years"));
        await expect(row).toContainText(`Started ${started}`);
      }
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: quote builder — a 3-year ₹2,400 domain line switched to Flexible drops the years and shows ₹67 a month (not ₹200)", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/new?customer=${CUST}`);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => { /* polling page */ });
      const bulkButton = page.getByRole("button", { name: "Bulk / many domains" }).first();
      await expect(bulkButton).toBeVisible({ timeout: 60_000 });
      await bulkButton.click();
      const dialog = page.getByRole("dialog", { name: /Bulk order — many domains/ });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await dialog.getByLabel("Plan").selectOption({ label: ITEM });
      await dialog.getByLabel("Register for").selectOption("3");
      await dialog.getByLabel("Domain 1").fill("r2723-flex.in");
      await dialog.getByRole("button", { name: "Add bulk line (1)" }).click();
      await expect(dialog).toHaveCount(0);
      const years = page.getByLabel(`Registration years for ${ITEM}`);
      await expect(years).toHaveValue("3");
      await expect(page.getByLabel(`Rate for ${ITEM}`)).toHaveValue("2400");

      /* Flexible (monthly): the years are gone and the rate is ONE year's month — ₹2,400 / 3 yrs = ₹800 a year → ₹67 */
      await page.getByLabel(`Commitment for ${ITEM}`).selectOption({ label: "Flexible (monthly)" });
      await expect(page.getByLabel(`Rate for ${ITEM}`)).toHaveValue("67");
      await expect(page.getByLabel(`Registration years for ${ITEM}`)).toHaveCount(0);
      /* back to Annual: one year (the rate is the yearly figure again), no hidden 3 years */
      await page.getByLabel(`Commitment for ${ITEM}`).selectOption({ label: "Annual commitment" });
      await expect(page.getByLabel(`Registration years for ${ITEM}`)).toHaveValue("1");
    } finally {
      await page.context().close();
    }
  });
});
