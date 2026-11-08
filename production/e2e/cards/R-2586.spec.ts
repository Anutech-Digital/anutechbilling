/**
 * Card test — R-2586 "Renewals: annual renewals after 90 days visible + subscriptions with no
 * renewal date shown, not silently dropped" (R-2550 card tests). One test per howToCheck step, on
 * the LOCAL app (E2E Test Co) through the Local test login. Run: `node scripts/ops/card-tests.mjs R-2586`.
 *
 * Step 1 — Renewals has a "Later (91+ days)" tab; the annual subscription renewing in ~150 days is
 *   in it with its renewal date, and it is NOT in the 61–90 tab.
 * Step 2 — a subscription with no renewal date is named in the "no renewal date" line, and its
 *   name opens that subscription on /subscriptions.
 *
 * Data (made fresh on every run and removed after it — E2E Test Co + the local docker DB only):
 *   CT R2586 Annual Pvt Ltd — one annual (yearly) subscription renewing current_date + 150;
 *   CT R2586 NoDate Pvt Ltd — one active subscription with renewal_date NULL.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const CUST_A = "c2586000-0000-4000-8000-000000000001";
const CUST_N = "c2586000-0000-4000-8000-000000000002";
const SUB_A = "c2586000-0000-4000-8000-000000000021";
const SUB_N = "c2586000-0000-4000-8000-000000000022";
const NAME_A = "CT R2586 Annual Pvt Ltd";
const NAME_N = "CT R2586 NoDate Pvt Ltd";
const PLAN = "E2E Google Workspace Business Starter";

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
  if (why || !c) throw new Error(`R-2586 card test refuses to write test data: ${why}`);
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

/** What an earlier run (or this one) made on the card's customers — and nothing else. */
function clearSql(tenant: string): string[] {
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  return [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], '{}'::uuid[], '{}'::text[], '{}'::text[], '{}'::text[], array['${CUST_A}', '${CUST_N}']);`,
  ];
}

/** The IST date 150 days ahead, as the page prints it ("2 Apr 2027") — read from the DB clock. */
let renewalShown = "";

function seed(): void {
  const c = container();
  psql(c, [
    ...clearSql(tenantId(c)),
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, notes) values
      ('${CUST_A}', :'tenant', '${NAME_A}', 'Maharashtra', '27', 'business', 'accounts@ct2586a.example', 'Card test R-2586 — local only'),
      ('${CUST_N}', :'tenant', '${NAME_N}', 'Maharashtra', '27', 'business', 'accounts@ct2586n.example', 'Card test R-2586 — local only');`,
    `insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, status, term_months, item_id, billing_cycle) values
      ('${SUB_A}', :'tenant', '${CUST_A}', '${NAME_A}', '${PLAN}', 'google', 10, 2500,
       (now() at time zone 'Asia/Kolkata')::date - 215, (now() at time zone 'Asia/Kolkata')::date + 150, 'active', 12, 'E2E-GW-STR', 'yearly'),
      ('${SUB_N}', :'tenant', '${CUST_N}', '${NAME_N}', '${PLAN}', 'google', 5, 1250,
       (now() at time zone 'Asia/Kolkata')::date - 30, null, 'active', 12, 'E2E-GW-STR', 'yearly');`,
    "commit;",
  ].join("\n"));
  renewalShown = psql(c, "select to_char((now() at time zone 'Asia/Kolkata')::date + 150, 'FMDD Mon YYYY');")[0].trim();
}

function clearAll(): void {
  const c = container();
  psql(c, [...clearSql(tenantId(c)), "commit;"].join("\n"));
}

test.describe("R-2586 — Renewals: Later (91+ days) tab + subscriptions with no renewal date", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seed();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAll(); // leave no test data behind
  });

  test("Step 1: Renewals → 'Later (91+ days)' tab lists the annual subscription ~150 days out, with its date", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals", /^Renewals$/);
    const main = page.locator("main");

    // Not in the 61–90 tab.
    await main.getByRole("tab", { name: /61–90/ }).click();
    await expect(main.getByText(NAME_A, { exact: true })).toHaveCount(0);

    const later = main.getByRole("tab", { name: /Later \(91\+ days\)/ });
    await expect(later).toBeVisible();
    await later.click();
    await expect(page).toHaveURL(/bucket=later/);
    const row = main.locator("tr", { hasText: NAME_A });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText(renewalShown);
    await expect(row).toContainText(/Due in 150d/);
    await page.context().close();
  });

  test("Step 2: a subscription with no renewal date is named on Renewals and opens on Subscriptions", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals", /^Renewals$/);
    const line = page.getByTestId("renewals-no-date");
    await expect(line).toBeVisible({ timeout: 60_000 });
    await expect(line).toContainText(/no renewal date/);
    const link = line.getByRole("link", { name: new RegExp(NAME_N) });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/subscriptions\\?open=${SUB_N}`), { timeout: 60_000 });
    await page.context().close();
  });
});
