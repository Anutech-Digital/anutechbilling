/**
 * Card test — R-2849 (R-2809c; R-2805, Pratik — a customer with 2+ YEARLY subscriptions billed on one bill last year got
 * one renewal quote per subscription). "Bill together" on Renewals now also offers yearly subscriptions: ONE renewal
 * quote, a line per subscription's next year (own seats, rate, period), GST on the total; paid in full → each renews by
 * its own term with ONE invoice (R-2848).
 *
 * NEEDS R-2847 (create_renewal_quote_together) + R-2848 (the gate open, record_payment renews each linked sub). Steps 3–4
 * skip themselves while the local DB's gate (r2847_together_payment_ready) is still false — they run once R-2848 is on it.
 * Run: `node scripts/ops/card-tests.mjs R-2849`.
 *
 * Data (fresh every run, E2E Test Co + the local docker DB only, fixed ids, removed after): CT R2849 Itbuzz Pvt Ltd with
 * two YEARLY subscriptions sold on ONE sale quote (Q-CT2849-SALE — "Billed together last time"), renewing in 10 and 20
 * days (both on the "≤30 days" tab): A "CT R2849 Business Standard" 20 seats × ₹1,080 a year, B "CT R2849 Business
 * Starter" 10 seats × ₹1,632. Step 4 pays inside a transaction that is rolled back (nothing kept).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2849000-0000-4000-8000-000000000001";
const SUB_A = "c2849000-0000-4000-8000-000000000021";
const SUB_B = "c2849000-0000-4000-8000-000000000022";
const SALE = "Q-CT2849-SALE";
const NAME = "CT R2849 Itbuzz Pvt Ltd";
const PLAN_A = "CT R2849 Business Standard";
const PLAN_B = "CT R2849 Business Starter";
const db = () => localDb("R-2849");
const T = E2E_TENANT_SQL;
const SUBS = `('${SUB_A}', '${SUB_B}')`;
const RENEW_A = "(public.ist_today() + 10)";
const RENEW_B = "(public.ist_today() + 20)";
const API = "/api/renewals/bill-together";

/** Every renewal quote naming either subscription (linked, or on its link rows). */
const renewalQuotes = `(select q.id from public.quotes q where q.tenant_id = ${T} and q.id <> '${SALE}' and (
    q.id in (select s.renewal_quote_id from public.subscriptions s where s.id in ${SUBS} and s.renewal_quote_id is not null)
    or q.id in (select l.quote_id from public.renewal_quote_subscriptions l where l.subscription_id in ${SUBS})))`;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set renewal_quote_id = null where id in ${SUBS} and tenant_id = ${T};
    delete from public.renewal_quote_subscriptions where subscription_id in ${SUBS} and tenant_id = ${T};
    delete from public.quotes where id in ${renewalQuotes};
    delete from public.subscriptions where id in ${SUBS} and tenant_id = ${T};
    delete from public.quotes where id = '${SALE}' and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2849@example.test', '07', 'India');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, amount, line_items, created_date)
      values ('${SALE}', ${T}, '${CUST}', '${NAME}', 'accepted', 44690, '[]'::jsonb, public.ist_today() - 355);
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain, quote_id)
      values ('${SUB_A}', ${T}, '${CUST}', '${NAME}', '${PLAN_A}', 'google', 20, 1800, 12, 'yearly',
              (${RENEW_A} - interval '12 months')::date, ${RENEW_A}, 'active', 'pending', true, 'ct2849-itbuzz.test', '${SALE}'),
             ('${SUB_B}', ${T}, '${CUST}', '${NAME}', '${PLAN_B}', 'google', 10, 1360, 12, 'yearly',
              (${RENEW_B} - interval '12 months')::date, ${RENEW_B}, 'active', 'pending', true, 'ct2849-itbuzz.test', '${SALE}');
    commit;`);
}

/** The local DB can make a together renewal quote (R-2848's migration opened R-2847's gate). */
function gateOpen(): boolean {
  return db().one("select coalesce((select public.r2847_together_payment_ready()), false)::text") === "true";
}

/** The live renewal quote both subscriptions are linked to: id · amount · line count · link rows. */
function together(): { id: string; amount: number; lines: number; links: number } | null {
  const r = db().one(`select q.id || '|' || q.amount || '|' || jsonb_array_length(q.line_items) || '|'
                             || (select count(*) from public.renewal_quote_subscriptions l where l.quote_id = q.id and l.released_at is null)
                        from public.quotes q
                       where q.id = (select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_A}')
                         and q.id = (select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_B}')`);
  if (!r) return null;
  const [id, amount, lines, links] = r.split("|");
  return { id, amount: Number(amount), lines: Number(lines), links: Number(links) };
}

async function openD30(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(page.getByTestId("bill-together-group").filter({ hasText: NAME })).toHaveCount(1, { timeout: 90_000 });
}

test.describe("R-2849 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Renewals '≤30 days' shows ONE Bill together group for the two yearly subscriptions, both ticked, 'one renewal quote'; fits 1280", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openD30(page);
    const group = page.getByTestId("bill-together-group").filter({ hasText: NAME });
    await expect(group.getByTestId("bill-together-why")).toHaveText("Billed together last time · one renewal quote");
    await expect(group.getByRole("checkbox", { name: new RegExp(PLAN_A) })).toBeChecked();
    await expect(group.getByRole("checkbox", { name: new RegExp(PLAN_B) })).toBeChecked();
    for (const w of [1280, 1276]) {
      await page.setViewportSize({ width: w, height: 800 });
      const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(m.scroll, `no horizontal scroll at ${w}`).toBeLessThanOrEqual(m.inner);
    }
    await page.context().close();
  });

  test("Step 2: Bill together → 'one renewal quote' dialog: a line per subscription with its own seats × rate and next-year period; total with GST on the total", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);
    const page = await pageAs(browser, baseURL, "owner");
    await openD30(page);
    await page.getByTestId("bill-together-group").filter({ hasText: NAME }).getByRole("button", { name: /Bill together/ }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Bill together — one renewal quote" })).toBeVisible({ timeout: 150_000 });
    const lines = dlg.getByTestId("bill-together-line");
    await expect(lines).toHaveCount(2, { timeout: 150_000 });
    if (!gateOpen()) {
      /* R-2848 not on this DB: every line says so and nothing can be made */
      await expect(dlg.getByTestId("bill-together-reason").first()).toContainText("not ready on this server");
      await expect(dlg.getByRole("button", { name: "Create renewal quote" })).toBeDisabled();
      await page.context().close();
      return;
    }
    await expect(lines.filter({ hasText: PLAN_A })).toContainText("20 seats × ₹1,080.00");
    await expect(lines.filter({ hasText: PLAN_B })).toContainText("10 seats × ₹1,632.00");
    await expect(dlg.getByTestId("bill-together-total")).toContainText("Total (2 lines)");
    /* GST once on ₹21,600 + ₹16,320 = ₹37,920 → ₹6,825.60 → ₹6,826 */
    await expect(dlg.getByTestId("bill-together-total")).toContainText("₹37,920.00 + GST ₹6,826.00 = ₹44,746.00");
    await page.context().close();
  });

  test("Step 3: Create renewal quote → ONE renewal quote with 2 lines, both subscriptions linked to it; a second Create opens the same quote", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);
    test.skip(!gateOpen(), "R-2848 (record_payment renews each linked subscription) is not on this local DB yet — runs once it lands");
    const page = await pageAs(browser, baseURL, "owner");
    await openD30(page);
    await page.getByTestId("bill-together-group").filter({ hasText: NAME }).getByRole("button", { name: /Bill together/ }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
    await dlg.getByRole("button", { name: "Create renewal quote" }).click();
    await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 120_000 });
    const q = together();
    expect(q, "both linked to ONE renewal quote").not.toBeNull();
    expect(q!.lines).toBe(2);
    expect(q!.links).toBe(2);
    expect(q!.amount).toBe(44746);
    expect(page.url()).toContain(`/quotes/${encodeURIComponent(q!.id)}`);
    /* retry / second tab → the same quote */
    const again = await page.request.post(API, { data: { ids: [SUB_A, SUB_B] }, timeout: 180_000 });
    expect(again.status(), await again.text()).toBe(200);
    expect(await again.json()).toMatchObject({ quoteId: q!.id, alreadyExisted: true, action: "renewal_quote" });
    await page.context().close();
  });

  test("Step 4: part payment renews none; paying the rest renews BOTH by their own term (+12 months) — rolled back", async () => {
    test.skip(!gateOpen() || !together(), "needs Step 3's renewal quote (R-2848 on the local DB)");
    const q = together()!;
    const renewed = `(select renewal_date = (${RENEW_A} + interval '12 months')::date from public.subscriptions where id = '${SUB_A}')::text || '|'
          || (select renewal_date = (${RENEW_B} + interval '12 months')::date from public.subscriptions where id = '${SUB_B}')::text`;
    /* record_payment — what Record payment / bank reconcile call */
    const out = db().psql(`begin;
      select public.record_payment('${q.id}', 1000, 'bank_transfer', 'CT-R2849-PAY1');
      select ${renewed};
      select public.record_payment('${q.id}', (select round(amount)::int - 1000 from public.quotes where id = '${q.id}'), 'bank_transfer', 'CT-R2849-PAY2');
      select ${renewed} || '|' || (select payment_status::text from public.quotes where id = '${q.id}');
      rollback;`);
    expect(out.at(-3), "after ₹1,000: A | B").toBe("false|false");
    expect(out.at(-1), "after the rest: A renewed | B renewed | quote").toBe("true|true|received");
  });

  test.skip("Step 5: the quote page / PDF print each line's own 'Subscription period' — looks judgement (service-period-r2849 unit tests cover the text)", () => {});
});
