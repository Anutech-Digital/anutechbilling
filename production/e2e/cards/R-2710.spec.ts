/**
 * Card test — R-2710 "Renewals: the row button opens the renewal quote in the editor (review → edit
 * seats/rate/term → Save & send); a renewal changed to 3 years renews for 3 years" (Pratik, 12 Nov).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2710`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   · CT R2710 Domains Pvt Ltd (Delhi, ct2710@example.test) with a yearly, NOT split-billed
 *     "Domain Registration .com" subscription (1 × ₹1,200 a year), renewing in 18 days → the 8–30 tab.
 * The payment in step 5 runs inside a rolled-back transaction (nothing is left behind).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const CUST = "c2710000-0000-4000-8000-000000000001";
const SUB = "c2710000-0000-4000-8000-000000000021";
const NAME = "CT R2710 Domains Pvt Ltd";
const PLAN = "Domain Registration .com";
const db = () => localDb("R-2710");

/** Every quote of this subscription (its renewal quotes and their revisions). */
const QUOTES = `(select q.id from public.quotes q where q.tenant_id = ${E2E_TENANT_SQL}
   and (q.renewal_subscription_id = '${SUB}' or q.notes like '%subscription ${SUB}%'))`;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set renewal_quote_id = null where id = '${SUB}';
    delete from public.renewal_email_log where subscription_id = '${SUB}';
    delete from public.quotes where tenant_id = ${E2E_TENANT_SQL} and (id in ${QUOTES} or revision_of in ${QUOTES});
    delete from public.subscriptions where id = '${SUB}' and tenant_id = ${E2E_TENANT_SQL};
    delete from public.customers where id = '${CUST}' and tenant_id = ${E2E_TENANT_SQL};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${E2E_TENANT_SQL}, '${NAME}', 'ct2710@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                      billing_cycle, start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB}', ${E2E_TENANT_SQL}, '${CUST}', '${NAME}', '${PLAN}', 'domain', 1, 100, 12, 'yearly',
              public.ist_today() - 347, public.ist_today() + 18, 'active', 'pending', true, null);
    commit;`);
}

const linked = () => db().one(`select coalesce(renewal_quote_id, '') from public.subscriptions where id = '${SUB}'`);
const quoteRow = (id: string) => db().one(`select status || ',' || extension_months || ',' || subtotal from public.quotes where id = '${id}'`);

async function row(page: Page) {
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  const r = page.locator("tr", { hasText: NAME }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2710 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Renewals → 8–30 tab: the row's one button is 'Review renewal quote' (nothing sent yet)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await row(page);
    await expect(await onlyOne(r.getByRole("button", { name: /Review renewal quote/ }), "Review renewal quote")).toBeVisible();
    await expect(r.getByRole("button", { name: /Send renewal quote/ })).toHaveCount(0);
  });

  test("Step 2: click it → /quotes/Q-…/edit opens with the line filled in, a DRAFT linked to the subscription; nothing emailed", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await row(page);
    await r.getByRole("button", { name: /Review renewal quote/ }).click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+\/edit$/, { timeout: 60_000 });
    const id = linked();
    expect(id).not.toBe("");
    expect(page.url()).toContain(`/quotes/${encodeURIComponent(id)}/edit`);
    expect(quoteRow(id)).toBe("draft,12,1200");
    expect(db().one(`select count(*) from public.renewal_email_log where subscription_id = '${SUB}'`)).toBe("0");
    /* The renewal footer button (its words follow the send plan: no vendor cost yet → "Save & ask for approval"). */
    await expect(page.locator("[data-renewal-send]").filter({ visible: true })).toBeVisible({ timeout: 60_000 });
  });

  test("Step 3: change the term to 3 years → the footer's next step is 'Save & send to customer'; sent (▾ Save & mark sent — local customer messages are off) → extension 36 months, ₹3,600; row reads 'Change renewal quote'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = linked();
    /* The local company has no catalogue row for this plan, so the line has no vendor cost and the
       margin would wait for approval — plant the cost the catalogue would give (₹900 a year). */
    db().psql(`update public.quotes set line_items = jsonb_set(line_items, '{0,cost}', '900'), total_cost = 900
                where id = '${id}' and status = 'draft' and tenant_id = ${E2E_TENANT_SQL};`);
    await openAppPage(page, `/quotes/${encodeURIComponent(id)}/edit`);
    const years = page.getByRole("combobox", { name: `Registration years for ${PLAN}` }).filter({ visible: true });
    await waitForHydrated(page, years);
    await years.selectOption("3");
    await expect(years).toHaveValue("3");
    await expect(page.getByRole("button", { name: "Save & send to customer" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Other ways to send" }).click();
    await page.getByRole("menuitem", { name: /Save & mark sent/ }).click();
    await expect.poll(() => quoteRow(id), { timeout: 60_000 }).toBe("sent,36,3600");
    const r = await row(page);
    await expect(r.getByRole("button", { name: /Change renewal quote/ })).toBeVisible({ timeout: 60_000 });
  });

  test("Step 4: Change renewal quote → the R2 draft opens in the editor; a second click re-opens the same R2 (no R3)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = linked();
    let r = await row(page);
    await r.getByRole("button", { name: /Change renewal quote/ }).click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${id}-R2/edit$`), { timeout: 60_000 });
    expect(quoteRow(`${id}-R2`)).toBe("draft,36,3600");
    r = await row(page);
    await r.getByRole("button", { name: /Change renewal quote/ }).click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${id}-R2/edit$`), { timeout: 60_000 });
    expect(db().one(`select count(*) from public.quotes where revision_of = '${id}'`)).toBe("1");
  });

  test("Step 5: paying the 3-year renewal quote (rolled back) (₹3,600 + GST) moves the renewal date +36 months", async () => {
    const id = linked();
    const out = db().psql(`begin;
      select public.record_payment('${id}', (select amount from public.quotes where id = '${id}'), 'bank_transfer', 'CT-R2710-PAY');
      select renewal_date = (public.ist_today() + 18 + interval '36 months')::date, mrr from public.subscriptions where id = '${SUB}';
      rollback;`);
    expect(out.at(-1)).toBe("t|100");
  });

  test.skip("Step 6: the quote PDF / email read 'Subscription period: 3 Years' — looks judgement (service-period unit tests cover the text)", () => {});
});
