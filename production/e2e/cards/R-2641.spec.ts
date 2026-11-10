/**
 * Card test — R-2641 "WhatsApp/phone links: remaining +91 places use the customer's country" (R-2639 follow-up).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2641`.
 *
 * Data (planted here, local docker DB only — scenarioTargetReason guard): SCN Wa Link Buyer (India, Delhi,
 * unregistered business, no phone) and one unpaid local tax invoice SCN-R2641-INV-1 for it (no saved
 * customer_country — the "older invoice" case of the card). Step 1 changes the customer through its Edit page
 * like the owner. Nothing is sent: the list / customer-page links are read from their href (wa.me/<number>),
 * and the invoice's WhatsApp tab is answered by a local stub page (route.fulfill) — the test reads the number
 * from the address the app opened. Each step sets the data it starts from, so one red step does not hide the
 * others; the planted rows are removed after the last step.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUSTOMER_ID = "c2641000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Wa Link Buyer";
const INVOICE = "SCN-R2641-INV-1";

function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env: Record<string, string> = {};
  const f = path.join(PROD, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`R-2641 card test refuses to write test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

/** The local test invoice is issued, so the delete goes through the trigger's own named way past it
    (app.invoice_amend_reason, transaction-local) — local docker DB only (psql()). */
function unplant(): void {
  psql(`
begin;
set local app.invoice_amend_reason = 'R-2641 card test cleanup (local test invoice)';
delete from public.invoices where id = '${INVOICE}' and tenant_id = (select id from public.tenants where email = '${E2E_TENANT_EMAIL}');
delete from public.customers where id = '${CUSTOMER_ID}' and tenant_id = (select id from public.tenants where email = '${E2E_TENANT_EMAIL}');
commit;`);
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.customers (id, tenant_id, name, address, city, state, state_code, pin_code, country, gst_treatment,
                              customer_type, contact_email, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', 'Saket', 'New Delhi', 'Delhi', '07', '110017', 'India', 'unregistered_business',
       'business', 'scn-walink@example.test', 'R-2641 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
/* An OLDER invoice keeps no customer_country (the card case): the snapshot trigger would copy India, so this one
   local insert skips user triggers (session_replication_role, transaction-local). */
set local session_replication_role = replica;
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items)
select '${INVOICE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 5900, 'pending', current_date - 5, current_date + 10,
       5000, 900, 18, false, 0, 'tax_invoice',
       '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Setup (one time)", "rate": 5000}]'::jsonb
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
set local session_replication_role = origin;
commit;`);
}

const saved = () => psql(`select coalesce(country, '') || '|' || coalesce(contact_phone, '') from public.customers where id = '${CUSTOMER_ID}';`)[0] ?? "";

/** Puts the customer where a step starts from (country + phone exactly as given). */
function setSaved(country: "India" | "United States", phone: string): void {
  if (!/^[+\d ]+$/.test(phone)) throw new Error("unexpected phone");
  const treatment = country === "India" ? "unregistered_business" : "overseas";
  psql(`update public.customers set country = '${country}', contact_phone = '${phone}', gst_treatment = '${treatment}'
         where id = '${CUSTOMER_ID}';`);
}

const digitsOf = (href: string | null): string => {
  if (!href) return "";
  const u = new URL(href);
  return u.searchParams.get("phone") ?? u.pathname.replace(/\D/g, "");
};

/** Customer → Edit: pick the region (searchable list) and/or type the phone like the owner, then Save. */
async function editCustomer(page: Page, opts: { country?: string; phone?: string }): Promise<void> {
  await openAppPage(page, `/customers/${CUSTOMER_ID}/edit`);
  await expect(page.locator("#contact_phone")).toBeVisible({ timeout: 60_000 });
  if (opts.country) {
    await page.locator("#country").click();
    await page.getByRole("searchbox", { name: "Search countries" }).fill(opts.country);
    await page.getByRole("option", { name: opts.country, exact: true }).click();
    /* Back to India from a foreign region: the US state list had no "Delhi", so the Registered
       state is empty and Save is refused until one is picked — the owner picks it (R-2645). */
    if (opts.country === "India") {
      await page.getByRole("tab", { name: "Address" }).click();
      const state = page.getByRole("combobox", { name: "Registered state" });
      if (await state.count() && !(await state.inputValue())) await state.selectOption("Delhi");
    }
  }
  if (opts.phone !== undefined) {
    const phone = page.locator("#contact_phone");
    await phone.fill("");
    await phone.pressSequentially(opts.phone);
    await phone.blur();
  }
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/customers/${CUSTOMER_ID}(?:$|[?#])`), { timeout: 60_000 });
}

/** Invoice page → WhatsApp: the number of the tab it opens (stubbed — nothing reaches WhatsApp). */
async function whatsAppPhoneFromInvoice(page: Page): Promise<string> {
  await page.context().route(/^https:\/\/(web\.whatsapp\.com|wa\.me|api\.whatsapp\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp stub (card test)</title>stub" }));
  await openAppPage(page, `/invoices/${INVOICE}`);
  const opened = page.context().waitForEvent("request", { predicate: (r) => /whatsapp\.com|wa\.me/.test(r.url()), timeout: 60_000 });
  await page.locator("main").getByRole("button", { name: "WhatsApp", exact: true }).first().click();
  return digitsOf((await opened).url());
}

test.describe("R-2641 — the customer list, customer page and invoice WhatsApp use the customer's country code", () => {
  onlyInCardTests();
  test.setTimeout(300_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) unplant(); });

  test("Step 1: Customer → Edit → Country = United States, Phone = 5551234567 → Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await editCustomer(page, { country: "United States", phone: "5551234567" });
      /* Saved as typed for a US customer — no +91 put in front of a US number. */
      expect(saved()).toMatch(/^United States\|(\+?1[\s-]?)?555[\s-]?123[\s-]?4567$/);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Customers list card → WhatsApp is 15551234567; the customer page's WhatsApp button too", async ({ browser, baseURL }) => {
    setSaved("United States", "5551234567"); // what step 1 saves: the number as typed, no code
    const page = await pageAs(browser, baseURL, "owner");
    try {
      /* The customer CARDS (with the WhatsApp chip) are the phone-width list (md:hidden); 1280 shows the table. */
      await page.setViewportSize({ width: 390, height: 844 });
      await openAppPage(page, "/customers");
      await page.getByRole("textbox", { name: "Search companies" }).filter({ visible: true }).first().fill(CUSTOMER);
      const listLink = page.locator('a[href*="wa.me/"]').filter({ hasText: "WhatsApp" }).filter({ visible: true });
      await expect(listLink).toHaveCount(1, { timeout: 60_000 });
      expect.soft(digitsOf(await listLink.getAttribute("href")), "customers list card").toBe("15551234567");

      await page.setViewportSize({ width: 1280, height: 900 });
      await openAppPage(page, `/customers/${CUSTOMER_ID}`);
      const pageLink = page.locator("main").getByRole("link", { name: "WhatsApp", exact: true }).first();
      await expect(pageLink).toBeVisible({ timeout: 60_000 });
      expect(digitsOf(await pageLink.getAttribute("href")), "customer page button").toBe("15551234567");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: the customer's invoice → WhatsApp → 15551234567; Country back to India → 915551234567", async ({ browser, baseURL }) => {
    setSaved("United States", "5551234567");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      expect.soft(await whatsAppPhoneFromInvoice(page), "US customer").toBe("15551234567");
      await editCustomer(page, { country: "India" });
      expect(await whatsAppPhoneFromInvoice(page), "India customer").toBe("915551234567");
    } finally {
      await page.context().close();
    }
  });
});
