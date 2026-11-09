/**
 * Card test — R-2620: a customer marked Overseas with NO country reads as India (G5), so a quote to it
 * was sent at 18% as an Indian sale. Now the quote page holds it with the reason and the fix, and the
 * builder refuses Send (the database refuses it too — supabase/tests/r2620_overseas_needs_country.test.sql).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2620`.
 *
 * Data: planted by this spec on the LOCAL docker DB (the customer form cannot make such a customer any
 * more — R-2537 refuses Overseas with no country; the rows come from the Zoho import): customer
 * "SCN Overseas No Country" (Overseas, country empty, no state) with draft quote Q-SCN-OV-1. Fixed ids,
 * re-planted on each run and left for a person to look at (same as a scenario).
 */
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const CUSTOMER_ID = "c2620000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Overseas No Country";
const QUOTE = "Q-SCN-OV-1";

function plant(): void {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const sql = `
\\set ON_ERROR_STOP 1
begin;
delete from public.quotes where id = '${QUOTE}';
delete from public.customers where id = '${CUSTOMER_ID}';
insert into public.customers (id, tenant_id, name, state, state_code, country, gst_treatment, customer_type, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', null, null, '', 'overseas', 'business', 'R-2620 card test: Overseas, country empty (like a Zoho import)'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost, tax_rate,
                           discount_pct, status, created_date, expires_date, billing_cycle, currency, line_items, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Export services', 1, 11800, 10000, 0, 18, 0, 'draft',
       current_date, current_date + 15, 'yearly', 'INR',
       '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Export services", "rate": 10000, "one_time": true}]'::jsonb,
       'R-2620 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
commit;
`;
  const r = spawnSync("docker", ["exec", "-i", "supabase_db_resellerosv3", "psql", "-X", "-q", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`planting R-2620 data failed: ${(r.stderr || r.stdout || "").trim()}`);
}

test.describe("R-2620 — Overseas customer with no country is held, not taxed as India", () => {
  onlyInCardTests();
  test.beforeAll(() => {
    if (CARD_TESTS_ON) plant();
  });

  test("Step 1: PDF / WhatsApp / email are locked with the country reason and 'Pick the customer's country'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${QUOTE}`);
    const note = page.getByRole("status").filter({ hasText: "are locked" }).first();
    await expect(note).toContainText(`${CUSTOMER} is marked Overseas but has no country`, { timeout: 60_000 });
    await expect(note).not.toContainText("state");
    await expect(note.getByRole("link", { name: "Pick the customer's country" })).toHaveAttribute("href", `/customers/${CUSTOMER_ID}`);
  });

  test("Step 2: the place of supply never reads Intra-state / CGST for it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/quotes/${QUOTE}`);
    await expect(page.getByText("GST head pending (customer is Overseas but has no country)").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Intra-state \(CGST \+ SGST\)/)).toHaveCount(0);
  });

  test("Step 3: the database refuses sending it (send / mark sent)", async () => {
    test.skip(true, "Proven by the SQL test r2620_overseas_needs_country (B, C) in one rolled-back transaction; a send from the UI would email the customer.");
  });
});
