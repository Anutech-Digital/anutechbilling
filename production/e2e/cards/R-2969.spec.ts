/**
 * Card test — R-2969 "Dashboard Company cards: clicking a row opens exactly the records behind
 * its number".
 *
 * LOCAL app (E2E Test Co) through the Local test login (Owner). Plants two customers created
 * now (real date, so always in this IST month — one of them archived, which "New customers"
 * counts too) so that row is never 0. Every other row is checked on whatever the local data has:
 * the number on the card must be the count (or the ₹ total) the opened list shows in its
 * "Showing: …" chip, and Clear must bring the full list back. No money row is planted.
 * Run: `node scripts/ops/card-tests.mjs R-2969`. Planted rows have fixed ids and are removed after.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2969";
const T = E2E_TENANT_SQL;
const id = (n: number) => `c2969000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NEW_CO = "CT R2969 New Company";
const ARCHIVED_CO = "CT R2969 Archived New Company";
const CLEAN = `delete from public.customers where tenant_id = ${T} and id in ('${id(1)}', '${id(2)}');`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.customers (id, tenant_id, name, state, state_code, customer_type, notes, is_active) values
      ('${id(1)}', ${T}, '${NEW_CO}', 'Maharashtra', '27', 'business', 'Card test R-2969 — local only', true),
      ('${id(2)}', ${T}, '${ARCHIVED_CO}', 'Maharashtra', '27', 'business', 'Card test R-2969 — local only', false);
    commit;`);
}

/** "₹1,23,456.50" / "₹64.9K" → rupees (K / L / Cr understood). */
function rupees(text: string): number {
  const m = /₹\s?([\d,]+(?:\.\d+)?)\s*(K|L|Cr)?/.exec(text);
  if (!m) throw new Error(`no rupee amount in "${text}"`);
  const n = Number(m[1].replace(/,/g, ""));
  return n * (m[2] === "K" ? 1e3 : m[2] === "L" ? 1e5 : m[2] === "Cr" ? 1e7 : 1);
}

/** The first whole number in a text ("3 invoices" → 3). */
const firstInt = (text: string) => Number(/(\d[\d,]*)/.exec(text)?.[1].replace(/,/g, "") ?? NaN);

test.describe("R-2969 — every Company row opens the records behind its number", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  const company = () => page.locator('section[aria-labelledby="dash-company"]');
  const row = (label: string): Locator =>
    company().getByRole("link").filter({ has: page.getByText(label, { exact: true }) });
  const banner = () => page.getByRole("status").filter({ hasText: /^Showing:/ });

  /** A row's figure and hint once loaded (never the skeleton or "—"). */
  async function read(label: string): Promise<{ value: string; hint: string }> {
    const r = row(label);
    const value = r.locator("span.font-serif");
    await expect(value).toBeVisible({ timeout: 60_000 });
    await expect(value).not.toHaveText("—");
    const hint = (await r.locator("span.text-3xs").first().textContent().catch(() => "")) ?? "";
    return { value: ((await value.textContent()) ?? "").trim(), hint: hint.trim() };
  }

  async function dashboard(): Promise<void> {
    await openAppPage(page, "/dashboard");
    await expect(company()).toBeVisible({ timeout: 60_000 });
  }

  /** Click the row; the list must open on `href` with the chip whose count is `count`. */
  async function openAndCount(label: string, href: string, chip: RegExp): Promise<{ count: number; text: string }> {
    await row(label).click();
    await expect(page).toHaveURL(new RegExp(href.replace(/[?]/g, "\\?")), { timeout: 60_000 });
    await expect(banner()).toContainText(chip, { timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => { /* polling page */ });
    const text = ((await banner().textContent()) ?? "").replace(/\s+/g, " ");
    const count = Number(/· (\d[\d,]*)/.exec(text)?.[1].replace(/,/g, "") ?? NaN);
    return { count, text };
  }

  async function clearShowsMore(): Promise<void> {
    await banner().getByRole("button", { name: "Clear" }).click();
    await expect(banner()).toHaveCount(0);
    await expect(page).not.toHaveURL(/focus=/);
  }

  test("Step 1: Dashboard → Company — no row opens a bare, unfiltered page", async () => {
    await dashboard();
    const hrefs = await company().getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.length).toBeGreaterThanOrEqual(9);
    for (const h of hrefs) expect(h, `row link ${h}`).toMatch(/\?(focus|tab|view|channel)=/);
  });

  test("Step 2: Money — Invoiced opens exactly its invoices, Collected adds up to the card", async () => {
    await dashboard();
    const inv = await read("Invoiced");
    const shown = await openAndCount("Invoiced", "/invoices?focus=issued-month", /This month · issued/);
    expect(shown.count).toBe(firstInt(inv.hint));
    // The chip's ₹ total is the card's figure (the card shows it rounded, e.g. ₹1.2L).
    const total = rupees(shown.text.split("·").pop() ?? "");
    expect(Math.abs(total - rupees(inv.value))).toBeLessThanOrEqual(Math.max(1, rupees(inv.value) * 0.05));
    await clearShowsMore();

    await dashboard();
    const col = await read("Collected");
    const paid = await openAndCount("Collected", "/payments?focus=received-month", /This month · received|Received this month/);
    const paidTotal = rupees(paid.text.split("·").pop() ?? "");
    expect(Math.abs(paidTotal - rupees(col.value))).toBeLessThanOrEqual(Math.max(1, rupees(col.value) * 0.05));
    await clearShowsMore();
  });

  test("Step 3: Customers & Ops — each row's list has the card's count", async () => {
    await dashboard();
    const fresh = await read("New customers");
    expect(Number(fresh.value)).toBeGreaterThanOrEqual(2);   // the two planted today
    const cust = await openAndCount("New customers", "/customers?focus=new-month", /This month · new customers/);
    expect(cust.count).toBe(Number(fresh.value));
    await expect(page.getByText(NEW_CO, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(ARCHIVED_CO, { exact: true }).first()).toBeVisible();   // archived, still new this month
    await clearShowsMore();

    await dashboard();
    const tickets = await read("Open tickets");
    const t = await openAndCount("Open tickets", "/support?focus=still-open", /Still open/);
    expect(t.count).toBe(Number(tickets.value));
    await clearShowsMore();

    await dashboard();
    if (await row("Monthly revenue (MRR)").count()) {
      const mrr = await read("Monthly revenue (MRR)");
      const m = await openAndCount("Monthly revenue (MRR)", "/subscriptions?focus=active", /Active subscriptions/);
      expect(m.count).toBe(firstInt(mrr.hint));
      const mrrTotal = rupees(m.text.split("·").pop() ?? "");
      expect(Math.abs(mrrTotal - rupees(mrr.value))).toBeLessThanOrEqual(Math.max(1, rupees(mrr.value) * 0.05));
      await clearShowsMore();

      await dashboard();
      const waiting = await read("Waiting to activate");
      const w = await openAndCount("Waiting to activate", "/provisioning?focus=waiting", /Waiting to activate/);
      expect(w.count).toBe(Number(waiting.value));
      await clearShowsMore();
    }
  });

  test("Step 4: Growth — Leads added and From the website open this month's leads", async () => {
    await dashboard();
    const added = await read("Leads added");
    await row("Leads added").click();
    await expect(page).toHaveURL(/\/lead-gen\?channel=all/, { timeout: 60_000 });
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText(/\d+ leads? this month/)).toBeVisible({ timeout: 60_000 });
    expect(firstInt((await dlg.getByText(/\d+ leads? this month/).textContent()) ?? "")).toBe(Number(added.value));
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page).not.toHaveURL(/channel=/);

    await dashboard();
    const web = await read("From the website");
    await row("From the website").click();
    await expect(page).toHaveURL(/\/lead-gen\?channel=website/, { timeout: 60_000 });
    await expect(dlg.getByText(/\d+ leads? this month/)).toBeVisible({ timeout: 60_000 });
    expect(firstInt((await dlg.getByText(/\d+ leads? this month/).textContent()) ?? "")).toBe(Number(web.value));
    await page.keyboard.press("Escape");

    await dashboard();
    if (await row("Trials started").count()) {
      const trials = await read("Trials started");
      const tr = await openAndCount("Trials started", "/subscriptions?focus=trials-month", /trials started/);
      expect(tr.count).toBe(Number(trials.value));
      await clearShowsMore();
    }
  });
});
