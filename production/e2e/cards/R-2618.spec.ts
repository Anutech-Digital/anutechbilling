/**
 * Card test — R-2618 "Renewal reminders/quote must never reuse a linked plan-change quote as the
 * renewal quote".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2618`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 *   · customer "CT R2618 Cust" with a licence subscription (10 seats, ₹2,700/month, renews in 10 days);
 *   · an unpaid Change plan quote Q-CT-R2618 (₹5,900, first line carries plan_change) linked to it
 *     through renewal_quote_id — what "Change plan" makes (step 1 of howToCheck).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const CUST = "c2618000-0000-4000-8000-0000000000c1";
const SUB = "c2618000-0000-4000-8000-0000000000b1";
const PCQ = "Q-CT-R2618";

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
  if (why || !c) throw new Error(`R-2618 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function e2eTenant(c: string): string {
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  return tenants[0].trim();
}

const CLEAN = (t: string) => `
  update public.subscriptions set renewal_quote_id = null where id = '${SUB}';
  delete from public.renewal_email_log where subscription_id = '${SUB}';
  delete from public.quotes where tenant_id = '${t}' and customer_id = '${CUST}';
  delete from public.subscriptions where id = '${SUB}';
  delete from public.customers where id = '${CUST}';`;

function clean(): void {
  const c = container();
  psql(c, CLEAN(e2eTenant(c)));
}

function seed(): void {
  const c = container();
  const t = e2eTenant(c);
  psql(c, `${CLEAN(t)}
    insert into public.customers (id, tenant_id, name) values ('${CUST}', '${t}', 'CT R2618 Cust');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                      start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
      values ('${SUB}', '${t}', '${CUST}', 'CT R2618 Cust', 'CT R2618 Starter', 'google', 10, 2700, 'active', 12,
              current_date - 355, current_date + 10, 'pending', 0, 0);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                               expires_date, line_items, is_renewal, extension_months, billing_cycle)
      values ('${PCQ}', '${t}', '${CUST}', 'CT R2618 Cust', 5900, 5000, 18, 'sent', 'awaiting', public.ist_today() + 5,
              jsonb_build_array(jsonb_build_object('id','plan-change-1','name','CT R2618 Standard','qty',10,'rate',500,'cost',0,
                'plan_change', jsonb_build_object('subscription_id','${SUB}','from_seats',10,'from_mrr',2700,'from_plan','CT R2618 Starter','seats',10,'new_mrr',5000))),
              true, 0, 'yearly');
    update public.subscriptions set renewal_quote_id = '${PCQ}' where id = '${SUB}';`);
}

function link(): string {
  const c = container();
  return (psql(c, `select coalesce(renewal_quote_id, '') from public.subscriptions where id = '${SUB}';`)[0] ?? "").trim();
}

test.describe("R-2618 — a linked Change plan quote is never sent or used as the renewal quote", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  let page: Page;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    clean();
  });

  test("Step 1: a licence subscription has an unpaid Change plan quote linked", async () => {
    expect(link()).toBe(PCQ);
  });

  test("Step 2: Resend on Renewals answers the plan-change message — no reminder, link unchanged", async () => {
    const res = await page.request.post("/api/renewals/send-now", { data: { subscription_id: SUB }, timeout: 60_000 });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    expect(res.status()).toBe(409);
    expect(body.error ?? "").toMatch(new RegExp(`Plan change quote ${PCQ} is pending on this subscription, so no renewal quote was made and no renewal reminder was sent`));
    const c = container();
    expect(psql(c, `select count(*) from public.renewal_email_log where subscription_id = '${SUB}';`)[0]).toBe("0");
    expect(link()).toBe(PCQ);
  });

  test("Step 3: after Cancel quote, Generate makes a real renewal quote — not the plan-change amount", async () => {
    const c = container();
    /* Cancel quote (R-2519) stores 'rejected'. R-2605's trigger lets go of the link; on a DB without
       it (or a row cancelled before it) the link stays — R-2618's helper then lets go of the closed
       quote itself. Either way Generate must make the real renewal quote. */
    psql(c, `update public.quotes set status = 'rejected' where id = '${PCQ}';`);
    const res = await page.request.post(`/api/subscriptions/${SUB}/generate-renewal-quote`, { data: {}, timeout: 60_000 });
    const body = (await res.json().catch(() => ({}))) as { error?: string; quoteId?: string; amount?: number };
    expect(body.error ?? "").not.toMatch(/Plan change quote/);
    expect(res.status(), `Generate answered ${res.status()}: ${body.error ?? ""}`).toBe(200);
    expect(body.quoteId).toBeTruthy();
    expect(body.quoteId).not.toBe(PCQ);
    expect(body.amount).not.toBe(5900);
    expect(link()).toBe(body.quoteId);
  });
});
