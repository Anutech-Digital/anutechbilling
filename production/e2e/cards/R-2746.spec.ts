/**
 * Card test — R-2746 "Renewal quote: a small 'Renewal · <from> – <to>' label above the line items on
 * every surface". One test per surface, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2746`. (The quote PDF's label is checked by the unit test
 * renewal-period-label-surfaces-r2746.test.tsx — the PDF here is only downloaded.)
 *
 * Data (local docker DB only, fixed ids, removed before and after):
 *   · CT R2746 Renewals Pvt Ltd (Delhi) with a yearly "Domain Registration .com" subscription
 *     (APP-made row: renewal_date = start_date + 12 months) renewing in 20 days. Its renewal quote is
 *     made by the same route the Renewals "Review renewal quote" button calls (a DRAFT).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";
import { formatDate } from "../../src/lib/utils";

const CUST = "c2746000-0000-4000-8000-000000000001";
const SUB = "c2746000-0000-4000-8000-000000000021";
const NAME = "CT R2746 Renewals Pvt Ltd";
const PLAN = "Domain Registration .com";
const db = () => localDb("R-2746");

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
      values ('${CUST}', ${E2E_TENANT_SQL}, '${NAME}', 'ct2746@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                      billing_cycle, start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB}', ${E2E_TENANT_SQL}, '${CUST}', '${NAME}', '${PLAN}', 'domain', 1, 100, 12, 'yearly',
              (public.ist_today() + 20 - interval '12 months')::date, public.ist_today() + 20, 'active', 'pending', true, 'r2746-check.in');
    commit;`);
}

const linked = () => db().one(`select coalesce(renewal_quote_id, '') from public.subscriptions where id = '${SUB}'`);
/** The label the quote must carry: the renewal term billing uses (app-made row → starts ON renewal_date,
 *  runs 12 months less a day) — read in SQL, the same dates the line's "Subscription period" prints. */
const expectedLabel = () => {
  const [from, to] = db().one(`select renewal_date::text || ',' || (renewal_date + interval '12 months' - interval '1 day')::date::text
    from public.subscriptions where id = '${SUB}'`).split(",");
  return `Renewal · ${formatDate(from)} – ${formatDate(to)}`;
};

async function reviewQuote(page: Page): Promise<string> {
  const existing = linked();
  if (existing) return existing;
  const res = await page.request.post(`/api/subscriptions/${SUB}/generate-renewal-quote`, { data: { review: true }, timeout: 120_000 });
  expect(res.ok(), await res.text()).toBe(true);
  const id = linked();
  expect(id).not.toBe("");
  return id;
}

const visibleLabel = (page: Page, what: string) =>
  onlyOne(page.getByTestId("renewal-period-label").filter({ visible: true }), what);

test.describe("R-2746 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Review renewal quote → the quote page's Line items say 'Renewal · <from> – <to>' with the line's own dates", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = await reviewQuote(page);
    await openAppPage(page, `/quotes/${encodeURIComponent(id)}`);
    const label = await visibleLabel(page, "quote page label");
    await expect(label).toContainText(expectedLabel(), { timeout: 60_000 });
  });

  test("Step 2: Quotes list → Actions → View PDF preview → the same label above the lines", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = linked();
    await openAppPage(page, `/quotes`);
    await page.getByRole("button", { name: `Actions for quote ${id}` }).filter({ visible: true }).first().click({ timeout: 60_000 });
    await page.getByRole("menuitem", { name: "View PDF preview" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("renewal-period-label")).toHaveText(expectedLabel(), { timeout: 60_000 });
  });

  test("Step 3: Edit the renewal draft → the label over the lines; the line no longer repeats the same Starts date", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${encodeURIComponent(linked())}/edit`);
    const label = await visibleLabel(page, "builder label");
    await expect(label).toContainText(expectedLabel(), { timeout: 60_000 });
    await expect(page.getByTestId("renewal-line-start").filter({ visible: true })).toHaveCount(0);
  });

  test("Step 4: the customer's link (/quote/<id>/accept, logged out) shows the same label in plain words", async ({ browser, baseURL }) => {
    const id = linked();
    const token = db().one(`select public_token::text from public.quotes where id = '${id}'`);
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    await page.goto(`/quote/${encodeURIComponent(id)}/accept?t=${encodeURIComponent(token)}`);
    const label = await visibleLabel(page, "accept page label");
    await expect(label).toHaveText(expectedLabel());
    await ctx.close();
  });

  test("Step 5: Download PDF works for the renewal quote (label text checked by the unit test)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const res = await page.request.get(`/api/v1/documents/quote/${encodeURIComponent(linked())}/pdf`, { timeout: 120_000 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
  });

  test("Step 6: a new-sale quote for the same customer shows no 'Renewal ·' label", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/new?customer=${CUST}`);
    await expect(page.getByRole("button", { name: "Bulk / many domains" }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("renewal-period-label")).toHaveCount(0);
  });
});
