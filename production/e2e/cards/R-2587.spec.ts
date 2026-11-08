/**
 * Card test — R-2587 "Quote billed in parts: show each instalment's status (1st paid / ₹X short)
 * and the next instalment's date + amount — not just '₹60 due now'" (R-2550 card tests).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2587`.
 *
 * Data (made fresh on every run and removed after the last step — E2E Test Co + the local docker DB
 * only), the shape of staging Q-A378-27-0021: customer "CT R2587 Parts Pvt Ltd", quote Q-CT-R2587,
 * annual, billed quarterly, ₹3,25,400 + 18% GST → four parts of ₹95,993; its subscription started
 * 7 days ago; ₹95,933 received (₹60 short on Part 1).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUST = "c2587000-0000-4000-8000-000000000001";
const SUB = "c2587000-0000-4000-8000-000000000021";
const PAY = "c2587000-0000-4000-8000-000000000031";
const QUOTE = "Q-CT-R2587";
const NAME = "CT R2587 Parts Pvt Ltd";

/* ── local docker DB (same guard as scripts/dev/scenario.mjs) ── */
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
  if (why || !c) throw new Error(`R-2587 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function tenantId(c: string): string {
  const t = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (t.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${t.length}`);
  return t[0].trim();
}

/** Only what this card test made. */
function clearSql(tenant: string): string {
  return `delete from public.payments where tenant_id = '${tenant}' and (id = '${PAY}' or quote_id = '${QUOTE}');
          delete from public.subscription_billings where tenant_id = '${tenant}' and subscription_id = '${SUB}';
          delete from public.subscriptions where tenant_id = '${tenant}' and id = '${SUB}';
          delete from public.quotes where tenant_id = '${tenant}' and id = '${QUOTE}';
          delete from public.customers where tenant_id = '${tenant}' and id = '${CUST}';`;
}

function seed(): void {
  const c = container();
  const tenant = tenantId(c);
  psql(c, `begin;
    ${clearSql(tenant)}
    insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST}', '${tenant}', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@ct2587.example', 'ct2587parts.example', 'Card test R-2587 — local only');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status,
                               billing_cycle, line_items, is_add_seats, is_one_off, created_date) values
      ('${QUOTE}', '${tenant}', '${CUST}', '${NAME}', 383972, 325400, 0, 18, 'accepted', 'partial', 'quarterly',
       '[{"id":"s","name":"E2E Google Workspace Business Starter","qty":100,"rate":3254,"cost":2500,"commitment":"annual"}]'::jsonb,
       false, false, current_date - 7);
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, domain, plan, vendor, seats, mrr, start_date, renewal_date,
                                      status, term_months, item_id, billing_cycle, quote_id) values
      ('${SUB}', '${tenant}', '${CUST}', '${NAME}', 'ct2587parts.example', 'E2E Google Workspace Business Starter', 'google', 100, 27117,
       current_date - 7, current_date + 358, 'active', 12, 'E2E-GW-STR', 'quarterly', '${QUOTE}');
    insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, notes) values
      ('${PAY}', '${tenant}', '${QUOTE}', '${CUST}', 95933, 'bank_transfer', 'CTUTR2587', 'received', now() - interval '5 days',
       'Card test R-2587 — local only');
    commit;`);
}

function clearAll(): void {
  const c = container();
  psql(c, `begin; ${clearSql(tenantId(c))} commit;`);
}

/* One run = one data set (R-2572): seeded once per runner, cleared after the last step. */
const RUN_MARKER = path.join(os.tmpdir(), `card-test-R-2587-${process.ppid}.seeded`);
const LAST_STEP = "Step 3";
const DATE = String.raw`\d{1,2} [A-Z][a-z]{2} \d{4}`;

test.describe("R-2587 — quote billed in parts: Part 1 received (₹60 short), Part 2's date", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON || fs.existsSync(RUN_MARKER)) return;
    seed();
    fs.writeFileSync(RUN_MARKER, new Date().toISOString());
  });
  const stepsRun: string[] = [];
  test.afterEach(() => {
    stepsRun.push(test.info().title);
  });
  test.afterAll(() => {
    if (!CARD_TESTS_ON || !stepsRun.some((t) => t.startsWith(LAST_STEP))) return;
    clearAll();
    fs.rmSync(RUN_MARKER, { force: true });
  });

  test("Step 1: the payment box says Part 1 of 4 received (₹60 short) and Part 2's date + amount — no 'due now'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAppPage(page, `/quotes/${QUOTE}`);
      await expect(page.getByText(new RegExp(`Part 1 of 4 received \\(₹60 short\\) · next part ₹95,993 \\(2 of 4\\) on ${DATE}\\.`)).first()).toBeVisible({ timeout: 60_000 });
      const list = page.getByTestId("instalment-list");
      await expect(list).toBeVisible();
      await expect(list.locator("li").nth(0)).toContainText(/Part 1 of 4.*₹95,993.*Received ₹95,933 on .* · ₹60 short/);
      await expect(list.locator("li").nth(1)).toContainText(new RegExp(`Part 2 of 4.*₹95,993.*Due ${DATE} · payment request goes that day`));
      await expect(list.locator("li").nth(2)).toHaveText(/2 more parts · ₹1,91,986/);
      expect(await page.locator("main").innerText()).not.toMatch(/₹60 due now/);
      /* fits 1280: no sideways scroll */
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: 'Record ₹60 balance' is there but not the orange main button", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      const rec = page.getByRole("button", { name: "Record ₹60 balance" });
      await expect(rec).toBeVisible({ timeout: 60_000 });
      await expect(rec).not.toHaveClass(/bg-amber/);
      await expect(page.getByRole("button", { name: /Record instalment payment/ })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: the PAID step and the badge read 'Paid to date (Part 1 ₹60 short) — next part ₹95,993 on <date>'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      const paidDot = page.locator(`[title^="Paid to date (Part 1 ₹60 short) — next part ₹95,993 on "]`);
      await expect(paidDot).toHaveCount(1, { timeout: 60_000 });
      expect(await paidDot.getAttribute("title")).toMatch(new RegExp(` on ${DATE}\\.$`));
      expect(await page.locator("main").innerText()).not.toMatch(/Partly paid/);
    } finally {
      await page.context().close();
    }
  });
});
