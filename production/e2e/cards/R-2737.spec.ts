/**
 * Card test — R-2737 "Renewals row: last invoice STATUS (Overdue N days / Cancelled / USD) + the
 * PERIOD it covers" (Pardeep, 13 Nov: "last invoice ke status bhi show hona chahiye, uska
 * subscription period bhi show hona chahiye").
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2737`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2737 Renewals Pvt Ltd", every plan's renewal date 5 days ago (Overdue tab):
 *   · D "CT R2737 Split Plan" — billed quarterly; its part (a calendar quarter) was invoiced as
 *     INV-CT2737-P (linked through the billing row, as the auto-issued part invoice is), due 43 days ago, unpaid → "Overdue 43d · ₹3,540"
 *     + "for <Mon YYYY – Mon YYYY>" from the billing row's stored period;
 *   · E "CT R2737 Annual Plan" — original sale Q-CT2737-ORIG (line start date set) invoiced and
 *     paid (INV-CT2737-A) → "Paid"; its renewal quote Q-CT2737-REN sent (renewal_term_date +
 *     12 months) → quote line "for 1 … – …" (the paper's Subscription period);
 *   · F "CT R2737 USD Plan" — a USD invoice (fx 84, ₹1,00,800, ₹42,000 in) → "Part paid · $700 due";
 *   · G "CT R2737 Cancelled Plan" — an older paid invoice and a NEWER void one → "Cancelled".
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2737000-0000-4000-8000-000000000001";
const SUB_D = "c2737000-0000-4000-8000-000000000021";
const SUB_E = "c2737000-0000-4000-8000-000000000022";
const SUB_F = "c2737000-0000-4000-8000-000000000023";
const SUB_G = "c2737000-0000-4000-8000-000000000024";
const SUB_H = "c2737000-0000-4000-8000-000000000025";
const SUB_I = "c2737000-0000-4000-8000-000000000026";
const SUBS = [SUB_D, SUB_E, SUB_F, SUB_G, SUB_H, SUB_I];
const BILL_D = "c2737000-0000-4000-8000-000000000031";
const BILL_G = "c2737000-0000-4000-8000-000000000032";
const NAME = "CT R2737 Renewals Pvt Ltd";
const QUOTES = ["Q-CT2737-ORIG", "Q-CT2737-REN", "PI-CT2737-1", "Q-CT2737-F", "Q-CT2737-G", "Q-CT2737-2L"];
const INVOICES = ["INV-CT2737-P", "INV-CT2737-A", "INV-CT2737-F", "INV-CT2737-G1", "INV-CT2737-G2", "INV-CT2737-2L"];
const db = () => localDb("R-2737");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2737", {
    invoiceIds: INVOICES,
    before: `update public.quotes set invoice_id = null where id in (${inList(QUOTES)}) and tenant_id = ${T};
             update public.subscription_billings set invoice_id = null where id in ('${BILL_D}', '${BILL_G}') and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in (${inList(SUBS)}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${inList(QUOTES)}) and tenant_id = ${T};
            delete from public.subscription_billings where id in ('${BILL_D}', '${BILL_G}') and tenant_id = ${T};
            delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = (start: string | null) => `jsonb_build_array(jsonb_build_object('name', 'CT R2737 line', 'qty', 1, 'rate', 12000, 'commitment', 'annual_yearly'${start ? `, 'start_date', (${start})::text` : ""}))`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2737@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB_D}', ${T}, '${CUST}', '${NAME}', 'CT R2737 Split Plan', 'google', 5, 500, 12, 'quarterly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true),
             ('${SUB_E}', ${T}, '${CUST}', '${NAME}', 'CT R2737 Annual Plan', 'google', 10, 1000, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true),
             ('${SUB_F}', ${T}, '${CUST}', '${NAME}', 'CT R2737 USD Plan', 'google', 10, 1000, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true),
             ('${SUB_G}', ${T}, '${CUST}', '${NAME}', 'CT R2737 Cancelled Plan', 'google', 2, 200, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true);
    -- D: a calendar-quarter part, invoiced, due 43 days ago, unpaid
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate)
      values ('${BILL_D}', ${T}, '${SUB_D}', public.ist_today() - 370, 1, date_trunc('month', public.ist_today() - 60)::date,
              date_trunc('month', public.ist_today() - 60)::date, (date_trunc('month', public.ist_today() - 60) + interval '3 months')::date, 3000, 18);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, subscription_billing_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('PI-CT2737-1', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', '${BILL_D}', public.ist_today() - 50, 3540, 3000, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2737-P', ${T}, '${CUST}', '${NAME}', null, 'pending', 3540, 540, 0, public.ist_today() - 50, public.ist_today() - 43);
    update public.subscription_billings set invoice_id = 'INV-CT2737-P' where id = '${BILL_D}';
    -- E: original sale (line start date) paid; renewal quote sent for the next term
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2737-ORIG', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 371, 14160, 12000, 18, ${line("public.ist_today() - 370")});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2737-A', ${T}, '${CUST}', '${NAME}', 'Q-CT2737-ORIG', 'paid', 14160, 2160, 14160, public.ist_today() - 369);
    update public.quotes set invoice_id = 'INV-CT2737-A' where id = 'Q-CT2737-ORIG';
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2737-REN', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, '${SUB_E}',
              public.ist_today() - 5, 12, public.ist_today() - 2, public.ist_today() + 10, 14160, 12000, 18, ${line(null)});
    update public.subscriptions set quote_id = 'Q-CT2737-ORIG', renewal_quote_id = 'Q-CT2737-REN' where id = '${SUB_E}';
    -- F: USD invoice, part paid, not yet due
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2737-F', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 20, 100800, 100800, 0, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date, currency, fx_rate)
      values ('INV-CT2737-F', ${T}, '${CUST}', '${NAME}', 'Q-CT2737-F', 'pending', 100800, 0, 42000, public.ist_today() - 20, public.ist_today() + 10, 'USD', 84);
    update public.quotes set invoice_id = 'INV-CT2737-F' where id = 'Q-CT2737-F';
    update public.subscriptions set quote_id = 'Q-CT2737-F' where id = '${SUB_F}';
    -- G: an older paid invoice, then a newer one that was voided
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2737-G', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 371, 2360, 2000, 18, '[]');
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2737-G1', ${T}, '${CUST}', '${NAME}', 'Q-CT2737-G', 'paid', 2360, 360, 2360, public.ist_today() - 369),
             ('INV-CT2737-G2', ${T}, '${CUST}', '${NAME}', null, 'void', 2360, 360, 0, public.ist_today() - 3);
    update public.quotes set invoice_id = 'INV-CT2737-G1' where id = 'Q-CT2737-G';
    update public.subscriptions set quote_id = 'Q-CT2737-G' where id = '${SUB_G}';
    commit;`);
  /* G2 is linked to the plan the way a re-raised invoice is: through a billed part of the plan */
  db().psql(`begin;
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id)
      values ('${BILL_G}', ${T}, '${SUB_G}', public.ist_today() - 370, 1, public.ist_today() - 370,
              public.ist_today() - 370, public.ist_today() - 5, 2000, 18, 'INV-CT2737-G2');
    commit;`);
  /* H + I: ONE invoice with two lines — two subscriptions with different periods (owner, 13 Nov) */
  const twoLines = `jsonb_build_array(
      jsonb_build_object('name', 'CT R2737 Line One', 'qty', 1, 'rate', 6000, 'commitment', 'annual_yearly', 'domain', 'h.ct2737.test', 'start_date', (public.ist_today() - 370)::text),
      jsonb_build_object('name', 'CT R2737 Line Two', 'qty', 1, 'rate', 6000, 'commitment', 'annual_yearly', 'domain', 'i.ct2737.test', 'start_date', (public.ist_today() - 300)::text))`;
  db().psql(`begin;
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, domain)
      values ('${SUB_H}', ${T}, '${CUST}', '${NAME}', 'CT R2737 Line One', 'google', 1, 500, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true, 'h.ct2737.test'),
             ('${SUB_I}', ${T}, '${CUST}', '${NAME}', 'CT R2737 Line Two', 'google', 1, 500, 12, 'yearly',
              public.ist_today() - 300, public.ist_today() - 5, 'active', 'notice_sent', true, 'i.ct2737.test');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, created_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2737-2L', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', public.ist_today() - 371, 14160, 12000, 18, ${twoLines});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date)
      values ('INV-CT2737-2L', ${T}, '${CUST}', '${NAME}', 'Q-CT2737-2L', 'paid', 14160, 2160, 14160, public.ist_today() - 369);
    update public.quotes set invoice_id = 'INV-CT2737-2L' where id = 'Q-CT2737-2L';
    update public.subscriptions set quote_id = 'Q-CT2737-2L' where id in ('${SUB_H}', '${SUB_I}');
    commit;`);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monYear = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const dmy = (iso: string) => `${Number(iso.slice(8, 10))} ${monYear(iso)}`;

async function rowOf(page: Page, plan: string): Promise<Locator> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2737 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: a split-billed row shows 'Invoice INV-… · Overdue 43d · ₹3,540' and the quarter it covers (from the billing row)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2737 Split Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(await onlyOne(docs.getByRole("link", { name: "INV-CT2737-P" }), "invoice link")).toBeVisible({ timeout: 60_000 });
    await expect(docs.getByTestId("renewal-last-invoice-status")).toHaveText("Overdue 43d · ₹3,540");
    const start = db().one(`select period_start::text from public.subscription_billings where id = '${BILL_D}'`);
    const lastDay = db().one(`select (period_end - 1)::text from public.subscription_billings where id = '${BILL_D}'`);
    await expect(docs.getByTestId("renewal-last-invoice-period")).toHaveText(`for ${monYear(start)} – ${monYear(lastDay)}`);
  });

  test("Step 2: an annual row shows its term '1 … – … · Paid' — the paper's Subscription period (line start + 12 months)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    /* the renewal quote is the newest quote sent; the paid original-sale invoice is the last invoice */
    const r = await rowOf(page, "CT R2737 Annual Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(docs.getByTestId("renewal-last-invoice-status")).toHaveText("Paid", { timeout: 60_000 });
    const from = db().one(`select (public.ist_today() - 370)::text`);
    const to = db().one(`select ((public.ist_today() - 370) + interval '12 months' - interval '1 day')::date::text`);
    await expect(docs.getByTestId("renewal-last-invoice-period")).toHaveText(`for ${dmy(from)} – ${dmy(to)}`);
  });

  test("Step 3: a sent renewal quote shows 'Q-… · Sent' and 'for <next term>' (renewal_term_date + 12 months)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2737 Annual Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(await onlyOne(docs.getByRole("link", { name: "Q-CT2737-REN" }), "quote link")).toBeVisible({ timeout: 60_000 });
    await expect(docs).toContainText("Sent");
    const from = db().one(`select (public.ist_today() - 4)::text`);
    const to = db().one(`select ((public.ist_today() - 5) + interval '12 months')::date::text`);
    await expect(docs.getByTestId("renewal-last-quote-period")).toHaveText(`for ${dmy(from)} – ${dmy(to)}`);
  });

  test("Step 4: a USD invoice shows its $ amount ('Part paid · $700 due')", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2737 USD Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(docs.getByTestId("renewal-last-invoice-status")).toHaveText("Part paid · $700 due", { timeout: 60_000 });
  });

  test("Step 5: the newest invoice cancelled → 'Cancelled', greyed (the older paid one does not hide it)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2737 Cancelled Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(await onlyOne(docs.getByRole("link", { name: "INV-CT2737-G2" }), "void invoice link")).toBeVisible({ timeout: 60_000 });
    /* R-2748: the row now also lists the invoice before it (G1, Paid) — read G2's own line */
    const status = docs.locator("[data-invoice-id='INV-CT2737-G2']").getByTestId("renewal-last-invoice-status");
    await expect(status).toHaveText("Cancelled");
    await expect(status).toHaveClass(/text-ink-3/);
  });

  test("Step 7: one invoice with two lines (two subscriptions, different start dates) → each row shows ITS line's period", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const term = (offset: number) => [
      db().one(`select (public.ist_today() - ${offset})::text`),
      db().one(`select ((public.ist_today() - ${offset}) + interval '12 months' - interval '1 day')::date::text`),
    ];
    for (const [plan, offset] of [["CT R2737 Line One", 370], ["CT R2737 Line Two", 300]] as const) {
      const r = await rowOf(page, plan);
      const docs = await onlyOne(r.getByTestId("renewal-last-docs"), `last docs ${plan}`);
      await expect(await onlyOne(docs.getByRole("link", { name: "INV-CT2737-2L" }), "shared invoice")).toBeVisible({ timeout: 60_000 });
      const [from, to] = term(offset);
      await expect(docs.getByTestId("renewal-last-invoice-period")).toHaveText(`for ${dmy(from)} – ${dmy(to)}`);
    }
  });

  test("Step 6: at 1280 nothing runs past the Actions column or the page edge; the full words are in a title", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await rowOf(page, "CT R2737 Split Plan");
    const docs = await onlyOne(r.getByTestId("renewal-last-docs"), "last docs");
    await expect(docs).toBeVisible({ timeout: 60_000 });
    const fit = await docs.evaluate((el) => {
      const td = el.closest("td")!;
      const cell = td.getBoundingClientRect();
      const lines = [...el.querySelectorAll("p")].map((p) => p.getBoundingClientRect());
      return {
        insideCell: lines.every((b) => b.right <= cell.right + 0.5),
        /* the block itself is no wider than the column (it used to take its max-content width) */
        blockInsideCell: el.getBoundingClientRect().right <= cell.right + 0.5,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(fit).toEqual({ insideCell: true, blockInsideCell: true, pageFits: true });
    await expect(docs.locator("[data-doc-line='invoice']")).toHaveAttribute("title", /Last invoice: INV-CT2737-P .*Overdue 43d · ₹3,540 · for /);
  });
});
