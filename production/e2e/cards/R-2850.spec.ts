/**
 * Card test — R-2850 (R-2809d; R-2805, Pratik): yearly "Bill together" END TO END on localhost, the way the owner
 * does it — every money step is pressed in the app (Bill together, Cancel quote, Record payment); nothing is paid
 * through SQL and nothing is rolled back. R-2847 (one renewal quote for 2+ yearly subscriptions) + R-2848 (paid in
 * full → each renews once by its own term, ONE invoice; cancel frees them) + R-2849 (the Bill together box / dialog).
 * Run: `node scripts/ops/card-tests.mjs R-2850`.
 *
 * Data: scenario "yearly-together" (scripts/dev/scenarios/yearly-together.sql — E2E Test Co, local docker DB only,
 * fixed ids c2850000-…): SCN Yearly Pair Pvt Ltd with two YEARLY subscriptions sold on one sale quote last year,
 * renewing in 10 and 20 days — A "SCN Yearly Standard" 20 seats × ₹1,080 a year, B "SCN Yearly Starter" 10 seats ×
 * ₹1,632. The scenario plants only the customer, last year's bare sale quote and the two subscriptions — no money row.
 * It is reloaded first in beforeAll (a crashed run does not block the next) and cleared in afterAll: that removes the
 * customer, both subscriptions and every quote / payment / invoice the steps below made for them.
 *
 * Money: ₹21,600 + ₹16,320 = ₹37,920 → GST 18% once on the total ₹6,825.60 → ₹6,826 → ₹44,746.
 * The SQL here only READS (what the screen cannot show at a glance: one quote, link rows, renewed once).
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2850000-0000-4000-8000-000000000001";
const SUB_A = "c2850000-0000-4000-8000-000000000021";
const SUB_B = "c2850000-0000-4000-8000-000000000022";
const NAME = "SCN Yearly Pair Pvt Ltd";
const PLAN_A = "SCN Yearly Standard";
const PLAN_B = "SCN Yearly Starter";
const TOTAL = 44746;
const PART = 1000;
/** A row's ⋯ menu item that makes that ONE subscription's own renewal quote. */
const OWN_QUOTE_ITEM = /renewal quote|Send renewal|Generate/i;
const db = () => localDb("R-2850");
const T = E2E_TENANT_SQL;

function scenario(flag: "--reset" | "--clear"): void {
  execFileSync(process.execPath, ["scripts/dev/scenario.mjs", "yearly-together", flag], { stdio: "pipe", timeout: 180_000 });
}

/** The dates the screens print, from the DB's own IST today: A renews in 10 days, B in 20; each next year is its own. */
type Dates = { aDue: string; bDue: string; aPeriod: string; bPeriod: string; aNext: string; bNext: string; invoicePeriod: string };
let dates: Dates;
function readDates(): Dates {
  const long = "'FMDD Mon YYYY'", short = "'FMDD Mon YY'";
  const a = "(public.ist_today() + 10)", b = "(public.ist_today() + 20)";
  const end = (d: string) => `((${d} + interval '12 months')::date - 1)`;
  const next = (d: string) => `(${d} + interval '12 months')::date`;
  const r = db().one(`select concat_ws('|',
      to_char(${a}, ${short}), to_char(${b}, ${short}),
      to_char(${a}, ${long}) || '–' || to_char(${end(a)}, ${long}), to_char(${b}, ${long}) || '–' || to_char(${end(b)}, ${long}),
      to_char(${next(a)}, ${short}), to_char(${next(b)}, ${short}),
      to_char(${a}, ${long}) || ' – ' || to_char(${end(b)}, ${long}))`).split("|");
  return { aDue: r[0], bDue: r[1], aPeriod: r[2], bPeriod: r[3], aNext: r[4], bNext: r[5], invoicePeriod: r[6] };
}

/** The live renewal quote BOTH subscriptions are linked to: id · amount · lines · live link rows · status. */
function together(): { id: string; amount: number; lines: number; links: number; status: string; paid: string } | null {
  const r = db().one(`select concat_ws('|', q.id, q.amount, jsonb_array_length(q.line_items),
                             (select count(*) from public.renewal_quote_subscriptions l where l.quote_id = q.id and l.released_at is null),
                             q.status, q.payment_status)
                        from public.quotes q
                       where q.tenant_id = ${T}
                         and q.id = (select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_A}')
                         and q.id = (select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_B}')`);
  if (!r) return null;
  const [id, amount, lines, links, status, paid] = r.split("|");
  return { id, amount: Number(amount), lines: Number(lines), links: Number(links), status, paid };
}

/** Both subscriptions as the DB has them: "A renewal date · state · linked quote | B …" (dates as days from IST today). */
function subs(): string {
  return db().one(`select string_agg((s.renewal_date - public.ist_today()) || ' ' || s.renewal_state || ' ' || coalesce(s.renewal_quote_id, '-'), ' | ' order by s.id)
                     from public.subscriptions s where s.id in ('${SUB_A}', '${SUB_B}') and s.tenant_id = ${T}`);
}

/** Days from IST today to each subscription's date one year after its old one (10 / 20 days + a year). */
function nextYearDays(): string {
  return db().one(`select ((public.ist_today() + 10) + interval '12 months')::date - public.ist_today() || '|' ||
                          (((public.ist_today() + 20) + interval '12 months')::date - public.ist_today())`);
}

/** Money the app recorded for this customer: received payments (count · sum) and invoices (count · ids). */
function money(): { payments: number; received: number; invoices: number; invoiceIds: string } {
  const r = db().one(`select concat_ws('|',
      (select count(*) from public.payments p where p.customer_id = '${CUST}' and p.tenant_id = ${T}),
      (select coalesce(sum(p.amount), 0) from public.payments p where p.customer_id = '${CUST}' and p.tenant_id = ${T}),
      (select count(*) from public.invoices i where i.customer_id = '${CUST}' and i.tenant_id = ${T}),
      (select coalesce(string_agg(i.id, ','), '') from public.invoices i where i.customer_id = '${CUST}' and i.tenant_id = ${T}))`).split("|");
  return { payments: Number(r[0]), received: Number(r[1]), invoices: Number(r[2]), invoiceIds: r[3] ?? "" };
}

/** One subscription's row — by its own product button (the other row also names this plan in "Bills with …"). */
const rowOf = (page: Page, plan: string): Locator =>
  page.getByTestId("renewal-row").filter({ hasText: NAME }).filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) });
const groupOf = (page: Page): Locator => page.getByTestId("bill-together-group").filter({ hasText: NAME });

/** Renewals → the "8–30" tab at 1280, with this customer's two rows on screen. */
async function openD30(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(rowOf(page, PLAN_A)).toHaveCount(1, { timeout: 120_000 });
  await expect(rowOf(page, PLAN_B)).toHaveCount(1, { timeout: 60_000 });
}

/** Bill together box → dialog → Create renewal quote → lands on the new quote's page. Returns the dialog as it stood. */
async function billTogether(page: Page): Promise<string> {
  await openD30(page);
  const btn = (await onlyOne(groupOf(page), "the customer's Bill together box", 120_000)).getByRole("button", { name: /Bill together/ });
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("heading", { name: "Bill together — one renewal quote" })).toBeVisible({ timeout: 150_000 });
  const lines = dlg.getByTestId("bill-together-line");
  await expect(lines).toHaveCount(2, { timeout: 150_000 });
  await expect(dlg.getByTestId("bill-together-total")).toContainText("Total (2 lines)", { timeout: 60_000 });
  const text = await dlg.innerText();
  const create = dlg.getByRole("button", { name: "Create renewal quote" });
  await expect(create).toBeEnabled({ timeout: 60_000 });
  await create.click();
  await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 120_000 });
  return text;
}

/** Record payment on the quote page (?pay=1 opens the sheet with the balance filled); `amount` null = what it offers. */
async function recordPayment(page: Page, quoteId: string, title: string, offered: number, amount: number | null): Promise<void> {
  await openAppPage(page, `/quotes/${encodeURIComponent(quoteId)}?pay=1`);
  const sheet = page.getByRole("dialog", { name: title });
  const box = sheet.locator("#amount");
  await expect(box).toBeVisible({ timeout: 90_000 });
  await expect(box, "the sheet offers what is still to pay").toHaveValue(String(offered), { timeout: 60_000 });
  if (amount !== null) {
    await box.fill(String(amount));
    await expect(box).toHaveValue(String(amount));
  }
  const confirm = sheet.getByRole("button", { name: "Confirm payment" });
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await confirm.click();
  await expect(sheet).toBeHidden({ timeout: 120_000 });
}

test.describe("R-2850 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; scenario("--reset"); dates = readDates(); });
  test.afterAll(() => { if (CARD_TESTS_ON) scenario("--clear"); });

  test("Step 1: Renewals '8–30' → Bill together → ONE renewal quote with 2 lines, each its own next year; total = sum + GST once", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const dialog = await billTogether(page);
      /* the dialog: a line per subscription — its own seats × rate and its OWN next year; GST once on the total */
      expect(dialog).toContain(`20 seats × ₹1,080.00 · ${dates.aPeriod} · ₹21,600.00`);
      expect(dialog).toContain(`10 seats × ₹1,632.00 · ${dates.bPeriod} · ₹16,320.00`);
      expect(dialog).toContain("₹37,920.00 + GST ₹6,826.00 = ₹44,746.00");

      const q = together();
      expect(q, "both subscriptions are linked to ONE renewal quote").not.toBeNull();
      expect(q).toMatchObject({ amount: TOTAL, lines: 2, links: 2, paid: "awaiting" });
      expect(page.url()).toContain(`/quotes/${encodeURIComponent(q!.id)}`);
      /* each stored line carries its own subscription and its own period */
      expect(db().one(`select string_agg((l->>'subscription_id') || ' ' || (l->>'period_start')::date - public.ist_today() || ' '
                                          || ((l->>'period_end')::date - (l->>'period_start')::date + 1), ' | ' order by l->>'subscription_id')
                         from public.quotes x, jsonb_array_elements(x.line_items) l where x.id = '${q!.id}'`))
        .toMatch(new RegExp(`^${SUB_A} 10 36[56] \\| ${SUB_B} 20 36[56]$`));

      /* the quote page: 2 lines, ₹37,920 + GST ₹6,826 = ₹44,746 */
      const main = page.locator("main");
      await expect(main.getByText("2 items", { exact: true })).toBeVisible({ timeout: 90_000 });
      await expect(await onlyOne(page.locator("tr").filter({ hasText: PLAN_A }), "the Standard line")).toContainText("₹21,600");
      await expect(await onlyOne(page.locator("tr").filter({ hasText: PLAN_B }), "the Starter line")).toContainText("₹16,320");
      await expect(main.getByText("₹37,920", { exact: true }).first()).toBeVisible();
      await expect(main.getByText("₹6,826", { exact: true })).toBeVisible();
      await expect(main.getByText(/^₹44,746/).first()).toBeVisible();

      /* Renewals: both rows now carry that one quote; nothing left to bill together */
      await openD30(page);
      await expect(rowOf(page, PLAN_A)).toContainText(q!.id, { timeout: 90_000 });
      await expect(rowOf(page, PLAN_B)).toContainText(q!.id);
      await expect(groupOf(page)).toHaveCount(0);
      expect(money()).toMatchObject({ payments: 0, invoices: 0 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Cancel quote on it → both rows are free again: 'No renewal quote yet', each offers its own renewal quote, Bill together is back", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const q = together();
    test.skip(!q, "needs Step 1's renewal quote");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${encodeURIComponent(q!.id)}`);
      const more = page.locator("main").getByRole("button", { name: "More", exact: true });
      await expect(more).toBeVisible({ timeout: 90_000 });
      await more.click();
      await page.getByRole("menuitem", { name: "Cancel quote" }).click();
      const dlg = page.getByRole("dialog", { name: `Cancel ${q!.id}?` });
      await dlg.locator("#cancel-quote-reason").fill("R-2850 card test — billing them again");
      const confirm = dlg.getByRole("button", { name: "Cancel quote" });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(dlg).toBeHidden({ timeout: 90_000 });

      /* DB: neither subscription points at it any more, its link rows are released, nothing renewed, no money */
      await expect.poll(() => subs(), { timeout: 60_000 }).toBe("10 pending - | 20 pending -");
      expect(db().one(`select count(*) filter (where released_at is null) || '/' || count(*) from public.renewal_quote_subscriptions where quote_id = '${q!.id}'`)).toBe("0/2");
      expect(money()).toMatchObject({ payments: 0, invoices: 0 });

      /* Renewals: both rows read "No renewal quote yet", the box offers them together again, and each row's ⋯ menu
         offers its OWN renewal quote */
      await openD30(page);
      for (const [plan, due] of [[PLAN_A, dates.aDue], [PLAN_B, dates.bDue]] as const) {
        const row = rowOf(page, plan);
        await expect(row).toContainText("No renewal quote yet", { timeout: 90_000 });
        await expect(row).toContainText(due);
        await expect(row).not.toContainText(q!.id);
        await expect(row.getByRole("button", { name: "Bill together" })).toBeVisible({ timeout: 60_000 });
      }
      await expect(groupOf(page)).toHaveCount(1, { timeout: 90_000 });
      for (const plan of [PLAN_A, PLAN_B]) {
        const menu = rowOf(page, plan).locator("td").last().getByRole("button").last();
        await expect(async () => {
          if ((await page.getByRole("menuitem").count()) === 0) await menu.click();
          await expect(page.getByRole("menuitem").first()).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 60_000 });
        expect((await page.getByRole("menuitem").allInnerTexts()).join(" | "), `${plan}: its ⋯ menu offers its own renewal quote`).toMatch(OWN_QUOTE_ITEM);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menuitem")).toHaveCount(0, { timeout: 10_000 });
      }
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Bill together again → a NEW renewal quote; a part payment (₹1,000) renews neither — same dates, 'Part paid', no invoice", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    test.skip(subs() !== "10 pending - | 20 pending -", "needs Step 2 (both subscriptions free again)");
    const cancelled = db().one(`select quote_id from public.renewal_quote_subscriptions where subscription_id = '${SUB_A}' and released_at is not null limit 1`);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await billTogether(page);
      const q = together();
      expect(q, "both linked to ONE new renewal quote").not.toBeNull();
      expect(q).toMatchObject({ amount: TOTAL, lines: 2, links: 2, paid: "awaiting" });
      expect(q!.id, "a new quote, not the cancelled one").not.toBe(cancelled);

      await recordPayment(page, q!.id, "Record payment received", TOTAL, PART);

      expect(subs(), "neither renewed").toBe(`10 pending ${q!.id} | 20 pending ${q!.id}`);
      expect(money()).toMatchObject({ payments: 1, received: PART, invoices: 0 });
      await openD30(page);
      for (const [plan, due] of [[PLAN_A, dates.aDue], [PLAN_B, dates.bDue]] as const) {
        const row = rowOf(page, plan);
        await expect(row).toContainText(q!.id, { timeout: 90_000 });
        await expect(row).toContainText("Part paid");
        await expect(row).toContainText(due);
        await expect(row).toContainText("No invoice yet");
        await expect(row.getByTestId("stage-chip")).not.toHaveAttribute("data-stage", "renewed");
      }
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Record the rest (₹43,746) → BOTH rows are Renewed, each on its own new date one year on — renewed once", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const q = together();
    test.skip(!q || money().received !== PART, "needs Step 3's part-paid renewal quote");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await recordPayment(page, q!.id, "Record additional payment", TOTAL - PART, null);

      /* DB: each moved by its OWN year (10 / 20 days + 12 months), state renewed, link cleared; one forward move each */
      const [a, b] = nextYearDays().split("|");
      await expect.poll(() => subs(), { timeout: 60_000 }).toBe(`${a} renewed - | ${b} renewed -`);
      expect(db().one(`select count(*) filter (where renewed_at is not null) || '/' || count(*) from public.renewal_quote_subscriptions where quote_id = '${q!.id}'`)).toBe("2/2");
      expect(db().one(`select string_agg(n::text, ',') from (select count(*) n from public.subscription_renewal_moves m
                        where m.quote_id = '${q!.id}' and m.subscription_id in ('${SUB_A}', '${SUB_B}') group by m.subscription_id) x`),
        "one renewal move per subscription").toBe("1,1");
      expect(db().one(`select seats || ' ' || round(mrr * 12) from public.subscriptions where id = '${SUB_A}'`), "A keeps its own seats and money").toBe("20 21600");
      expect(db().one(`select seats || ' ' || round(mrr * 12) from public.subscriptions where id = '${SUB_B}'`), "B keeps its own seats and money").toBe("10 16320");

      /* Renewals: gone from '8–30'; under Later (search by name) both read Renewed with their own new dates */
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAppPage(page, "/renewals?bucket=later", /Renewals/);
      const search = page.getByPlaceholder("Search customer or domain");
      await expect(page.getByTestId("renewal-row").first()).toBeVisible({ timeout: 120_000 });
      await search.fill("SCN Yearly Pair");
      for (const [plan, next] of [[PLAN_A, dates.aNext], [PLAN_B, dates.bNext]] as const) {
        const row = await onlyOne(rowOf(page, plan), `the ${plan} row under Later`, 90_000);
        await expect(row.getByTestId("stage-chip")).toHaveAttribute("data-stage", "renewed", { timeout: 90_000 });
        await expect(row.getByTestId("stage-chip")).toContainText("Renewed");
        await expect(row).toContainText(next);
        await expect(row).toContainText("No renewal quote yet");
      }
      await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
      await expect(page.getByTestId("renewal-row").first()).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId("renewal-row").filter({ hasText: NAME })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 5: Invoices shows ONE GST invoice for the customer — '2 subscriptions', ₹44,746, Paid; its page lists both lines", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);
    const m = CARD_TESTS_ON ? money() : null;
    test.skip(!m || m.received !== TOTAL, "needs Step 4 (the renewal quote paid in full)");
    expect(m, "two payments (₹1,000 + ₹43,746), ONE invoice").toMatchObject({ payments: 2, received: TOTAL, invoices: 1 });
    const inv = m!.invoiceIds;
    expect(db().one(`select status || ' ' || amount || ' ' || jsonb_array_length(line_items) from public.invoices where id = '${inv}'`)).toBe(`paid ${TOTAL} 2`);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/invoices", /Invoices/);
      const row = await onlyOne(page.locator("main tr").filter({ hasText: NAME }), "the customer's one invoice row", 120_000);
      await expect(row).toContainText(inv);
      await expect(row).toContainText(`2 subscriptions · ${dates.invoicePeriod}`);
      await expect(row).toContainText("₹44,746");
      await expect(row).toContainText("Paid");

      await openAppPage(page, `/invoices/${encodeURIComponent(inv)}`);
      const main = page.locator("main");
      await expect(main.getByText("Line Items (2)")).toBeVisible({ timeout: 90_000 });
      await expect(await onlyOne(page.locator("tr").filter({ hasText: PLAN_A }), "the Standard line")).toContainText("₹21,600");
      await expect(await onlyOne(page.locator("tr").filter({ hasText: PLAN_B }), "the Starter line")).toContainText("₹16,320");
      await expect(main.getByText(/Tax Total: ₹6,826 \(18%\)/)).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});
