/**
 * Card test — R-2754 "Renewal quote from Renewals: 'Notes for customer' shows 'Renewal quote
 * (operator-generated) for subscription <uuid>'; no way back to Renewals".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2754`.
 *
 * Data (local docker DB only, fixed ids, removed before and after): CT R2754 Domains Pvt Ltd with a
 * yearly "Domain Registration .com" subscription renewing in 18 days (the 8–30 tab). Its renewal
 * quote is made by the row's own "Review renewal quote" button (a DRAFT, notes = the system
 * sentence "Renewal quote (operator-generated) for subscription <uuid>"). The howToCheck names
 * SCN Kochi Hosting (same shape, already in E2E Test Co); the test plants its own row so a Save
 * never changes that one.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, waitForHydrated } from "./card-steps";

const CUST = "c2754000-0000-4000-8000-000000000001";
const SUB = "c2754000-0000-4000-8000-000000000021";
const NAME = "CT R2754 Domains Pvt Ltd";
const PLAN = "Domain Registration .com";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const db = () => localDb("R-2754");

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
      values ('${CUST}', ${E2E_TENANT_SQL}, '${NAME}', 'ct2754@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                      billing_cycle, start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB}', ${E2E_TENANT_SQL}, '${CUST}', '${NAME}', '${PLAN}', 'domain', 1, 100, 12, 'yearly',
              public.ist_today() - 347, public.ist_today() + 18, 'active', 'pending', true, null);
    commit;`);
}

const linked = () => db().one(`select coalesce(renewal_quote_id, '') from public.subscriptions where id = '${SUB}'`);
const notesOf = (id: string) => db().one(`select replace(coalesce(notes, ''), chr(10), ' ') from public.quotes where id = '${id}'`);

async function clickWhenReady(button: Locator) {
  await expect(button).toBeVisible({ timeout: 60_000 });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
}

async function row(page: Page) {
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  const r = page.locator("tr", { hasText: NAME }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

/** Renewals → 8–30 → the row's "Review renewal quote" → the editor, loaded. */
async function reviewFromRenewals(page: Page) {
  const r = await row(page);
  await clickWhenReady(r.getByRole("button", { name: /Review renewal quote|Change renewal quote/ }));
  await expect(page).toHaveURL(/\/quotes\/[^/]+\/edit\?returnTo=%2Frenewals%3Fbucket%3Dd30$/, { timeout: 120_000 });
  const box = page.locator("#qb-notes").filter({ visible: true });
  await waitForHydrated(page, box);
  await expect(box).not.toHaveValue("", { timeout: 60_000 });
  return box;
}

test.describe("R-2754 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Renewals → 8–30 tab → 'Review renewal quote' opens the editor (with the way back to that tab)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await reviewFromRenewals(page);
    const id = linked();
    expect(id).not.toBe("");
    /* The stored note still names the subscription (the Renewals link) — the editor only hides it. */
    expect(notesOf(id)).toContain(`subscription ${SUB}`);
  });

  test("Step 2: 'Notes for customer' has no long id — the plain line the customer reads", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const box = await reviewFromRenewals(page);
    const text = await box.inputValue();
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/operator-generated|for subscription/i);
    expect(text).toMatch(/^Renewal (?:of|for)\b/);
    const staff = await onlyOne(page.locator("[data-staff-note]").filter({ visible: true }), "staff note");
    await expect(staff).toContainText("not shown to the customer");
    await expect(staff).not.toContainText(UUID);
  });

  test("Step 3: 'Back to Renewals' shows; Save draft (note edited) → back on the 8–30 tab; the quote stays linked", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const box = await reviewFromRenewals(page);
    const back = await onlyOne(page.locator("[data-back-to-renewals]").filter({ visible: true }), "Back to Renewals");
    await expect(back).toHaveText(/Back to Renewals/);
    await expect(back).toHaveAttribute("href", "/renewals?bucket=d30");
    const id = linked();
    await box.fill("Renewal for 12 months. Thank you for your business.");
    await expect(box).toHaveValue("Renewal for 12 months. Thank you for your business.");
    await page.getByRole("button", { name: "Save draft" }).filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/renewals\?bucket=d30$/, { timeout: 120_000 });
    await expect.poll(() => notesOf(id), { timeout: 60_000 }).toContain("Thank you for your business.");
    expect(notesOf(id)).toContain(`subscription ${SUB}`);       // open-renewal-quotes still finds it
    expect(notesOf(id)).toContain("Staff only (not shown to the customer):");
    const r = await row(page);
    await expect(r.getByRole("button", { name: /Review renewal quote/ })).toBeVisible({ timeout: 60_000 });
  });
});
