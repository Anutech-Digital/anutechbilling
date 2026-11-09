/**
 * Card test — R-2639 "Overseas customer phone / WhatsApp gets +91 — use the customer's country dialling code".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2639`.
 *
 * Data (planted here, local docker DB only — scenarioTargetReason guard): SCN Dial Code Buyer (India, Delhi,
 * unregistered business, no phone) and a SENT quote Q-SCN-DIAL-1 for it. The steps change the customer's
 * country / phone through the customer Edit page exactly like the owner. "Send on WhatsApp" opens a new tab;
 * every request to web.whatsapp.com / wa.me is answered by a local stub page (route.fulfill), so nothing is
 * sent — the test reads the phone from the WhatsApp address the app opened. The planted rows are removed after
 * the last step.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUSTOMER_ID = "c2639000-0000-4000-8000-000000000001";
const CUSTOMER = "SCN Dial Code Buyer";
const QUOTE = "Q-SCN-DIAL-1";

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
  if (why || !c) throw new Error(`R-2639 card test refuses to write test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function unplant(): void {
  psql(`
begin;
delete from public.quotes where id = '${QUOTE}';
delete from public.customers where id = '${CUSTOMER_ID}';
commit;`);
}

function plant(): void {
  unplant();
  psql(`
begin;
insert into public.customers (id, tenant_id, name, address, city, state, state_code, pin_code, country, gst_treatment,
                              customer_type, contact_email, notes)
select '${CUSTOMER_ID}', t.id, '${CUSTOMER}', 'Saket', 'New Delhi', 'Delhi', '07', '110017', 'India', 'unregistered_business',
       'business', 'scn-dial@example.test', 'R-2639 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct, status,
                           payment_status, created_date, billing_cycle, currency, line_items, is_one_off, notes)
select '${QUOTE}', t.id, '${CUSTOMER_ID}', '${CUSTOMER}', 'SCN Setup', 1, 5900, 5000, 18, 0, 'sent', 'awaiting',
       (now() at time zone 'Asia/Kolkata')::date, 'yearly', 'INR',
       '[{"id": "line-1", "qty": 1, "cost": 0, "name": "SCN Setup (one time)", "rate": 5000, "one_time": true}]'::jsonb,
       true, 'R-2639 card test'
  from public.tenants t where t.email = '${E2E_TENANT_EMAIL}';
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

/** Every WhatsApp address the app opens is answered by a stub page — nothing reaches WhatsApp. */
async function stubWhatsApp(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/(web\.whatsapp\.com|wa\.me|api\.whatsapp\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp stub (card test)</title>stub" }));
}

/** The phone digits of the WhatsApp tab the quote page opens (web.whatsapp.com/send?phone= or wa.me/<n>). */
async function whatsAppPhoneFromQuote(page: Page): Promise<string> {
  await stubWhatsApp(page.context());
  await openAppPage(page, `/quotes/${QUOTE}`);
  const opened = page.context().waitForEvent("request", { predicate: (r) => /whatsapp\.com|wa\.me/.test(r.url()), timeout: 60_000 });
  await page.locator("main").getByRole("button", { name: "Send on WhatsApp" }).first().click();
  const u = new URL((await opened).url());
  return u.searchParams.get("phone") ?? u.pathname.replace(/\D/g, "");
}

/** Customer → Edit: pick the region (searchable list) and/or type the phone like the owner, then Save. */
async function editCustomer(page: Page, opts: { country?: string; phone?: string }): Promise<void> {
  await openAppPage(page, `/customers/${CUSTOMER_ID}/edit`);
  await expect(page.locator("#contact_phone")).toBeVisible({ timeout: 60_000 });
  if (opts.country) {
    await page.locator("#country").click();
    await page.getByRole("searchbox", { name: "Search countries" }).fill(opts.country);
    await page.getByRole("option", { name: opts.country, exact: true }).click();
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

test.describe("R-2639 — a customer's WhatsApp number gets the dialling code of the customer's country", () => {
  onlyInCardTests();
  /* Not serial: each step sets the data it starts from, so a red step 1 (the form) still lets steps 2–3
     show whether the WhatsApp link itself is right. A failed step restarts the worker → plant() again. */
  test.setTimeout(300_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) plant(); });
  test.afterAll(() => { if (CARD_TESTS_ON) unplant(); });

  test("Step 1: Customer → Edit → Country = United States, Phone = 5551234567 (no +) → Save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await editCustomer(page, { country: "United States", phone: "5551234567" });
      /* Saved as typed for a US customer — no +91 put in front of a US number. */
      expect(saved()).toMatch(/^United States\|(\+?1[\s-]?)?555[\s-]?123[\s-]?4567$/);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the customer's quote → Send on WhatsApp → the WhatsApp address has phone=15551234567 (not 915551234567)", async ({ browser, baseURL }) => {
    setSaved("United States", "5551234567"); // what step 1 saves: the number as typed, no code
    const page = await pageAs(browser, baseURL, "owner");
    try {
      expect(await whatsAppPhoneFromQuote(page)).toBe("15551234567");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Country back to India → 915551234567; phone '+44 7911 123456' → 447911123456 (no 91)", async ({ browser, baseURL }) => {
    setSaved("United States", "5551234567");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await editCustomer(page, { country: "India" });
      expect.soft(await whatsAppPhoneFromQuote(page)).toBe("915551234567");
      await editCustomer(page, { phone: "+44 7911 123456" });
      expect(await whatsAppPhoneFromQuote(page)).toBe("447911123456");
    } finally {
      await page.context().close();
    }
  });
});
