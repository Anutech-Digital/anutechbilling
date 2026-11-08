/**
 * Card test — R-2580 "Quote preview / PDF: a Monthly flex quote with a one-time line shows the
 * whole total ×12 as /month" (R-2550 card tests; follow-up of R-2193).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2580`.
 *
 * Data (made fresh on every run and removed after the last step — E2E Test Co + the local docker DB
 * only): customer "CT R2580 Flex Pvt Ltd" and its quote Q-CT-R2580 as R-2193's bank sale stores it —
 * 10 seats × ₹264 Flexible (monthly) + a ₹1,200 one-time domain, ₹4,531 incl 18% GST. The domain
 * line is stored FIRST on purpose (an older ordering — the screens must read the term off the seats).
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
const CUST = "c2580000-0000-4000-8000-000000000001";
const QUOTE = "Q-CT-R2580";
const NAME = "CT R2580 Flex Pvt Ltd";

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
  if (why || !c) throw new Error(`R-2580 card test refuses to write test data: ${why}`);
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

/** Only what this card test made: its quote and its customer. */
function clearSql(tenant: string): string {
  return `delete from public.quotes where id = '${QUOTE}' and tenant_id = '${tenant}';
          delete from public.customers where id = '${CUST}' and tenant_id = '${tenant}';`;
}

function seed(): void {
  const c = container();
  const tenant = tenantId(c);
  psql(c, `begin;
    ${clearSql(tenant)}
    insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST}', '${tenant}', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@ct2580.example', 'ct2580flex.example', 'Card test R-2580 — local only');
    insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate, status, payment_status,
                               billing_cycle, line_items, is_add_seats, is_one_off, created_date) values
      ('${QUOTE}', '${tenant}', '${CUST}', '${NAME}', 4531, 3840, 0, 18, 'sent', 'awaiting', 'monthly',
       '[{"id":"d","name":"CT R2580 Domain registration","qty":1,"rate":1200,"cost":800,"one_time":true},
         {"id":"s","name":"E2E Google Workspace Business Starter","qty":10,"rate":264,"cost":200,"commitment":"monthly"}]'::jsonb,
       false, false, current_date);
    commit;`);
}

function clearAll(): void {
  const c = container();
  psql(c, `begin; ${clearSql(tenantId(c))} commit;`);
}

/* One run = one data set (R-2572): seeded once per runner, cleared after the last step. */
const RUN_MARKER = path.join(os.tmpdir(), `card-test-R-2580-${process.ppid}.seeded`);
const LAST_STEP = "Step 2";

test.describe("R-2580 — flex + one-time quote: seats per month, one-time once", () => {
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

  test("Step 1: open the sale's quote → Preview: first invoice ₹4,531, then ₹3,115/mo, domain ₹1,416 once", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, `/quotes/${QUOTE}`);
      await page.getByRole("button", { name: /^Preview$/ }).click();
      const doc = page.getByTestId("preview-document");
      await expect(doc).toBeVisible({ timeout: 60_000 });
      await expect(doc.getByText("First invoice (incl. one-time)")).toBeVisible();
      await expect(page.getByTestId("preview-flex-monthly")).toHaveText(/Then each month\s*₹3,115\/mo/);
      await expect(page.getByTestId("preview-flex-once")).toHaveText(/One-time, billed once with the first invoice\s*₹1,416/);
      const text = (await doc.textContent()) ?? "";
      expect(text).not.toContain("₹4,531/mo");
      expect(text).not.toContain("₹1,200/mo");
      expect(text).not.toContain("₹100/mo");
      expect(text).not.toMatch(/54,372|Annual contract value/);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the quote PDF prints the same three lines", async () => {
    test.skip(true, "PDF text is compressed — the same QuotePDF render is checked in src/lib/quotes/flex-one-time-r2580.test.tsx; open Download PDF to see it");
  });
});
