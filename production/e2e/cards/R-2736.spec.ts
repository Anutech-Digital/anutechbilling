/**
 * Card test — R-2736 "Renewal quotes: price and cost always from the catalogue".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2736`.
 *
 * Data (local docker DB only, fixed ids, removed before and after):
 *   · CT R2736 Workspace Pvt Ltd: 20 seats of "Google Workspace Business Standard", ₹16,000 a month
 *     (₹800/seat/month = ₹9,600 a seat a year — above the catalogue list ₹736, so the test also shows the price is NOT taken from the catalogue), renewing in 18 days, NO item_id — the shape of
 *     Q-F588-27-0156 (SCN Kochi). E2E Test Co's catalogue calls the row "E2E Google Workspace Business
 *     Standard" (wholesale ₹620/seat/month), so the old exact-name lookup found nothing and the line
 *     went out at cost 0 → "Margin unknown" → owner approval.
 *   · CT R2736 Bespoke Pvt Ltd: 2 seats of "CT R2736 Bespoke Plan" — no catalogue row at all, so the
 *     cost stays unknown and the approval stays.
 * Both quotes are made by the route the Renewals "Send renewal" button calls (a DRAFT).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const CUST_GW = "c2736000-0000-4000-8000-000000000001";
const CUST_BESPOKE = "c2736000-0000-4000-8000-000000000002";
const SUB_GW = "c2736000-0000-4000-8000-000000000021";
const SUB_BESPOKE = "c2736000-0000-4000-8000-000000000022";
const SUBS = `('${SUB_GW}', '${SUB_BESPOKE}')`;
const db = () => localDb("R-2736");

const QUOTES = `(select q.id from public.quotes q where q.tenant_id = ${E2E_TENANT_SQL}
   and (q.renewal_subscription_id in ${SUBS} or q.notes like '%subscription ${SUB_GW}%' or q.notes like '%subscription ${SUB_BESPOKE}%'))`;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set renewal_quote_id = null where id in ${SUBS};
    delete from public.renewal_email_log where subscription_id in ${SUBS};
    delete from public.quotes where tenant_id = ${E2E_TENANT_SQL} and (id in ${QUOTES} or revision_of in ${QUOTES});
    delete from public.subscriptions where id in ${SUBS} and tenant_id = ${E2E_TENANT_SQL};
    delete from public.customers where id in ('${CUST_GW}', '${CUST_BESPOKE}') and tenant_id = ${E2E_TENANT_SQL};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country) values
      ('${CUST_GW}', ${E2E_TENANT_SQL}, 'CT R2736 Workspace Pvt Ltd', 'ct2736a@example.test', '07', 'India'),
      ('${CUST_BESPOKE}', ${E2E_TENANT_SQL}, 'CT R2736 Bespoke Pvt Ltd', 'ct2736b@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                      billing_cycle, start_date, renewal_date, status, renewal_state, auto_renew, item_id) values
      ('${SUB_GW}', ${E2E_TENANT_SQL}, '${CUST_GW}', 'CT R2736 Workspace Pvt Ltd', 'Google Workspace Business Standard', 'google',
       20, 16000, 12, 'yearly', (public.ist_today() + 18 - interval '12 months')::date, public.ist_today() + 18, 'active', 'pending', true, null),
      ('${SUB_BESPOKE}', ${E2E_TENANT_SQL}, '${CUST_BESPOKE}', 'CT R2736 Bespoke Pvt Ltd', 'CT R2736 Bespoke Plan', 'other',
       2, 1000, 12, 'yearly', (public.ist_today() + 18 - interval '12 months')::date, public.ist_today() + 18, 'active', 'pending', true, null);
    commit;`);
}

const linked = (sub: string) => db().one(`select coalesce(renewal_quote_id, '') from public.subscriptions where id = '${sub}'`);
const lineOf = (id: string) => db().one(`select (line_items->0->>'rate') || ',' || (line_items->0->>'cost') || ',' || coalesce(line_items->0->>'item_id', '') || ',' || total_cost from public.quotes where id = '${id}'`);

/** The draft renewal quote — the same POST the Renewals "Send renewal" button makes. */
async function reviewQuote(page: Page, sub: string): Promise<string> {
  const existing = linked(sub);
  if (existing) return existing;
  const res = await page.request.post(`/api/subscriptions/${sub}/generate-renewal-quote`, { data: { review: true }, timeout: 120_000 });
  expect(res.ok(), await res.text()).toBe(true);
  const id = linked(sub);
  expect(id).not.toBe("");
  return id;
}

async function openEditor(page: Page, id: string) {
  await openAppPage(page, `/quotes/${encodeURIComponent(id)}/edit`);
  const send = page.locator("[data-renewal-send]").filter({ visible: true });
  await waitForHydrated(page, send);
  await expect(send).toHaveAttribute("data-approval-ready", "1", { timeout: 60_000 });
  return send;
}

test.describe("R-2736 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Send renewal for the Workspace customer → line cost = catalogue ₹7,440 a seat (₹620 × 12), price stays the customer's ₹9,600 (not the catalogue ₹8,832), no item_id", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = await reviewQuote(page, SUB_GW);
    expect(lineOf(id)).toBe(`9600,7440,,${7440 * 20}`);
  });

  test("Step 2: in the editor the margin is shown (no 'Margin unknown') and the owner gets the plain send button — no approval step", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const send = await openEditor(page, linked(SUB_GW));
    await expect(send).not.toHaveAttribute("data-renewal-step", /approval/);
    await expect(page.getByText("Margin unknown").filter({ visible: true })).toHaveCount(0);
  });

  test("Step 3: a plan with no catalogue row → cost stays unknown (0), 'Margin unknown' shows and the approval is still asked", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = await reviewQuote(page, SUB_BESPOKE);
    expect(lineOf(id)).toBe("6000,0,,0");
    const send = await openEditor(page, id);
    await expect(send).toHaveAttribute("data-renewal-step", "open-approval");
    await expect(page.getByText("Margin unknown").filter({ visible: true }).first()).toBeVisible();
  });
});
