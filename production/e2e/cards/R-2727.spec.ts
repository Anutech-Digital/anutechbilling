/**
 * Card test — R-2727 "Staging-check follow-ups (R-2710 / R-2712 / R-2722)": the renewal line's
 * 'Starts' date, the renewal quote's approval step for the owner, Bulk dialog focus after
 * '+ Add domain'. (R-2713 part 1 rides on item 1; the payroll item moved to R-2733.)
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2727`.
 *
 * Data (local docker DB only, fixed ids, removed before and after):
 *   · CT R2727 Domains Pvt Ltd (Delhi) with a yearly "Domain Registration .com" subscription
 *     (1 × ₹1,200 a year) renewing in 18 days. Its renewal quote is made by the same route the
 *     Renewals "Send renewal" button calls (a DRAFT). The local company has no catalogue row
 *     for the plan, so the line's cost is unknown → the OWNER must approve it (R-388) — the shape
 *     of the staging domain renewal (cost 0).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";
import { formatDate } from "../../src/lib/utils";

const CUST = "c2727000-0000-4000-8000-000000000001";
const SUB = "c2727000-0000-4000-8000-000000000021";
const NAME = "CT R2727 Domains Pvt Ltd";
const PLAN = "Domain Registration .com";
const db = () => localDb("R-2727");

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
      values ('${CUST}', ${E2E_TENANT_SQL}, '${NAME}', 'ct2727@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                      billing_cycle, start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB}', ${E2E_TENANT_SQL}, '${CUST}', '${NAME}', '${PLAN}', 'domain', 1, 100, 12, 'yearly',
              (public.ist_today() + 18 - interval '12 months')::date, public.ist_today() + 18, 'active', 'pending', true, null);
    commit;`);
}

const linked = () => db().one(`select coalesce(renewal_quote_id, '') from public.subscriptions where id = '${SUB}'`);
const approvalOf = (id: string) => db().one(`select status || ',' || coalesce(approval_status::text, '') || ',' || coalesce(approval_tier::text, '') from public.quotes where id = '${id}'`);
/** The renewal period's first day, by billing's rule (followingTermStart): the planted subscription is an
 *  APP-made row (renewal_date = start_date + 12 months) → the next term starts ON renewal_date, and
 *  record_payment rolls it from there. Checked in SQL so the date is the same one billing uses. */
const renewalStart = () => db().one(`select case when start_date + interval '12 months' = renewal_date then renewal_date else renewal_date + 1 end::text from public.subscriptions where id = '${SUB}'`);
const isAppMadeRow = () => db().one(`select (start_date + interval '12 months' = renewal_date)::text from public.subscriptions where id = '${SUB}'`);

/** The draft renewal quote — the same POST the Renewals "Send renewal" button makes. */
async function reviewQuote(page: Page): Promise<string> {
  const existing = linked();
  if (existing) return existing;
  const res = await page.request.post(`/api/subscriptions/${SUB}/generate-renewal-quote`, { data: { review: true }, timeout: 120_000 });
  expect(res.ok(), await res.text()).toBe(true);
  const id = linked();
  expect(id).not.toBe("");
  return id;
}

async function openEditor(page: Page, id: string) {
  await openAppPage(page, `/quotes/${encodeURIComponent(id)}/edit`);
  const send = page.locator("[data-renewal-send]").filter({ visible: true });
  await waitForHydrated(page, send);
  /* the approval step is judged once the team and the quote's makers have loaded */
  await expect(send).toHaveAttribute("data-approval-ready", "1", { timeout: 60_000 });
  return send;
}

test.describe("R-2727 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  /* R-2746: the renewal start now shows ONCE, in the "Renewal · <from> – <to>" label over the lines;
     the line's read-only Starts (same date) is no longer repeated. */
  test("Step 1: Send renewal → editor: the renewal start billing uses (ON the renewal date for an app-made subscription) shows over the lines, not an empty dd-mm-yyyy box", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = await reviewQuote(page);
    await openEditor(page, id);
    const label = await onlyOne(page.getByTestId("renewal-period-label").filter({ visible: true }), "renewal period label");
    expect(isAppMadeRow()).toBe("true");
    expect(renewalStart()).toBe(db().one(`select (public.ist_today() + 18)::text`));
    await expect(label).toContainText(`Renewal · ${formatDate(renewalStart())} – `, { timeout: 60_000 });
    await expect(page.getByTestId("renewal-line-start").filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: `Start date for ${PLAN}` })).toHaveCount(0);
  });

  test("Step 2 (R-2713 part 1): at phone width the renewal start is on screen without opening 'More'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 390, height: 844 });
    await openEditor(page, linked());
    const label = await onlyOne(page.getByTestId("renewal-period-label").filter({ visible: true }), "renewal period label (phone)");
    await expect(label).toContainText(`Renewal · ${formatDate(renewalStart())} – `);
  });

  test("Step 3: a MANAGER on the same quote (owner must approve: cost unknown) → 'Save & ask for approval' really asks → pending, owner tier, nothing sent", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "manager");
    const id = linked();
    const send = await openEditor(page, id);
    await expect(send).toHaveAttribute("data-renewal-step", "ask-approval");
    await expect(send).toHaveText("Save & ask for approval");
    await send.click();
    await expect.poll(() => approvalOf(id), { timeout: 60_000 }).toBe("draft,pending,owner");
    expect(db().one(`select count(*) from public.renewal_email_log where subscription_id = '${SUB}'`)).toBe("0");
  });

  test("Step 4: the OWNER (did not make it) → 'Save & open approval' → lands on the quote with the approval open → Approve → approved, still a draft (nothing emailed)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const id = linked();
    const send = await openEditor(page, id);
    await expect(send).toHaveAttribute("data-renewal-step", "open-approval");
    await expect(send).toHaveText("Save & open approval");
    await expect(page.getByRole("button", { name: "Save & ask for approval" })).toHaveCount(0);
    await send.click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${id}$`), { timeout: 120_000 });
    const drawer = page.getByRole("dialog").filter({ hasText: /Approve/ });
    await expect(drawer).toBeVisible({ timeout: 60_000 });
    await drawer.getByRole("button", { name: /^Approve/ }).click();
    await expect.poll(() => approvalOf(id), { timeout: 60_000 }).toMatch(/^draft,approved,/);
  });

  test("Step 5: Bulk / many domains → '+ Add domain' puts the cursor in the new row (typing goes into Domain 2)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/new?customer=${CUST}`);
    const bulkButton = page.getByRole("button", { name: "Bulk / many domains" }).first();
    await expect(bulkButton).toBeVisible({ timeout: 60_000 });
    await bulkButton.click();
    const dialog = page.getByRole("dialog", { name: /Bulk order — many domains/ });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByLabel("Domain 1").fill("r2727-a.in");
    await dialog.getByRole("button", { name: "Add domain" }).click();
    await expect(dialog.getByLabel("Domain 2")).toBeFocused();
    await page.keyboard.type("r2727-b.in");
    await expect(dialog.getByLabel("Domain 2")).toHaveValue("r2727-b.in");
  });
});
