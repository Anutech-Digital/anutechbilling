/**
 * Card test — R-1717 "Subscriptions table: '₹ due' off-screen on a laptop; no link from an invoice
 * to its subscription" (R-2550 card tests). One test per howToCheck step, on the LOCAL app
 * (E2E Test Co) through the Local test login. Run: `node scripts/ops/card-tests.mjs R-1717`.
 *
 * Step 1 — at 1280×800 and 1366×768 (sidebar open) the Subscriptions table's Payment column (where
 *   the ₹ due shows since R-2382), Status and the row's ⋮ are inside the window: no horizontal
 *   scroll on the page or on any box around the table.
 * Step 2 — an invoice raised for a subscription part shows "Open subscription", and the link opens
 *   that subscription's drawer. Also for the OLD invoice of a part that was credited and raised
 *   again (R-1717 fix: before it, that invoice lost the link — INV-F588-27-0049 on local data).
 *
 * Data (made fresh on every run and removed after it — E2E Test Co + the local docker DB only):
 *   CT R1717 Link Pvt Ltd with one E2E Google Workspace subscription billed in quarters; its first
 *   quarter was billed by CT-R1717-OLD, credited, and billed again by CT-R1717-NEW.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, loginLocal, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const ACCT = "c1957000-0000-4000-8000-000000000a01"; // SCN_ACCOUNT_ID (scripts/dev/scenarios/index.mjs)
const CUST = "c1717000-0000-4000-8000-000000000001";
const SUB = "c1717000-0000-4000-8000-000000000021";
const NAME = "CT R1717 Link Pvt Ltd";
const DOMAIN = "ct1717link.example";
const PLAN = "E2E Google Workspace Business Starter";
const INV = { old: "CT-R1717-OLD", now: "CT-R1717-NEW" };

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
  if (why || !c) throw new Error(`R-1717 card test refuses to write test data: ${why}`);
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

/** What an earlier run (or this one) made on the card's customer — and nothing else. */
function clearSql(tenant: string): string[] {
  const common = fs.readFileSync(path.join(PROD, "scripts", "dev", "scenarios", "_common.sql"), "utf8");
  return [
    `\\set tenant '${tenant}'`,
    `\\set acct '${ACCT}'`,
    "begin;",
    "select set_config('scn.tenant', :'tenant', true), set_config('scn.acct', :'acct', true);",
    common,
    `select pg_temp.scn_clear(:'tenant'::uuid, '{}'::uuid[], '{}'::uuid[], '{}'::text[], '{}'::text[], '{}'::text[], array['${CUST}']);`,
  ];
}

function invoiceSql(id: string, status: string): string {
  return `('${id}', :'tenant', '${CUST}', '${NAME}', 29500, '${status}', current_date - 20, current_date + 10,
     25000, 4500, 18, false, 0, 'tax_invoice',
     '[{"id": "instalment-1", "qty": 10, "cost": 0, "name": "${PLAN}", "rate": 2500, "description": "Per seat · quarter 1"}]'::jsonb, null)`;
}

function seed(): void {
  const c = container();
  psql(c, [
    ...clearSql(tenantId(c)),
    `insert into public.customers (id, tenant_id, name, state, state_code, customer_type, contact_email, domain, notes) values
      ('${CUST}', :'tenant', '${NAME}', 'Maharashtra', '27', 'business', 'accounts@${DOMAIN}', '${DOMAIN}', 'Card test R-1717 — local only');`,
    `insert into public.subscriptions (id, tenant_id, customer_id, customer_name, domain, plan, vendor, seats, mrr, start_date, renewal_date, status, term_months, item_id, billing_cycle) values
      ('${SUB}', :'tenant', '${CUST}', '${NAME}', '${DOMAIN}', '${PLAN}', 'google', 10, 8333,
       current_date - 20, current_date + 345, 'active', 12, 'E2E-GW-STR', 'quarterly');`,
    `insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
                                  taxable_value, tax_amount, tax_rate, inter_state, paid_amount, document_kind, line_items, quote_id) values
      ${invoiceSql(INV.old, "void")}, ${invoiceSql(INV.now, "pending")};`,
    `insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end,
                                               taxable_amount, tax_rate, invoice_id, credited_invoice_ids) values
      (:'tenant', '${SUB}', current_date - 20, 1, current_date - 20, current_date - 20, current_date + 72, 25000, 18,
       '${INV.now}', array['${INV.old}']);`,
    "commit;",
  ].join("\n"));
}

function clearAll(): void {
  const c = container();
  psql(c, [...clearSql(tenantId(c)), "commit;"].join("\n"));
}

/** Seed ONCE per run (a failed step restarts the worker and runs beforeAll again). */
function seedOncePerRun(): void {
  const marker = path.join(os.tmpdir(), `card-test-R-1717-${process.ppid}.seeded`);
  if (fs.existsSync(marker)) return;
  seed();
  fs.writeFileSync(marker, new Date().toISOString());
}

/** Where the Subscriptions table's columns end, and every box that scrolls sideways. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector("table.table-fixed") as HTMLTableElement | null;
    const right = (sel: string) => {
      const el = table?.querySelector(sel) as HTMLElement | null;
      return el ? Math.round(el.getBoundingClientRect().right) : null;
    };
    const scrollers: string[] = [];
    for (let p = table?.parentElement ?? null; p; p = p.parentElement) {
      if (p.scrollWidth > p.clientWidth + 1 && getComputedStyle(p).overflowX !== "visible") {
        scrollers.push(`${p.tagName.toLowerCase()} ${p.scrollWidth}>${p.clientWidth}`);
      }
    }
    const headers = [...(table?.querySelectorAll("thead th") ?? [])].map((h) => ({
      text: (h.textContent ?? "").trim(),
      right: Math.round(h.getBoundingClientRect().right),
    }));
    return {
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      rows: table?.querySelectorAll("tbody tr").length ?? 0,
      headers,
      paymentCell: right('tbody td[data-col="payment"]'),
      actionsCell: right('tbody td[data-col="actions"]'),
      scrollers,
    };
  });
}

test.describe("R-1717 — Subscriptions fit a laptop; an invoice links to its subscription", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (CARD_TESTS_ON) seedOncePerRun();
  });
  test.afterAll(() => {
    if (CARD_TESTS_ON) clearAll(); // leave no test data behind
  });

  for (const vp of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
    test(`Step 1: ${vp.width}×${vp.height} — Subscriptions shows Payment (₹ due), Status and ⋮ without a side-scroll`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: vp });
      const page = await context.newPage();
      try {
        await loginLocal(page, "owner");
        // Measured on the WHOLE list (every row of E2E Test Co), not a filtered one.
        await openAppPage(page, "/subscriptions");
        await expect(page.locator("main table.table-fixed tbody tr").first()).toBeVisible({ timeout: 60_000 });
        const m = await measure(page);
        const at = (label: RegExp) => m.headers.find((h) => label.test(h.text));
        expect(m.rows).toBeGreaterThan(0);
        for (const label of [/^Payment/, /^Status/, /^Actions/]) {
          const h = at(label);
          expect(h, `${label} header`).toBeTruthy();
          expect(h!.right, `${label} header ends inside the ${vp.width}px window`).toBeLessThanOrEqual(m.innerWidth);
        }
        expect(m.paymentCell).not.toBeNull();
        expect(m.paymentCell!).toBeLessThanOrEqual(m.innerWidth);
        expect(m.actionsCell!).toBeLessThanOrEqual(m.innerWidth);
        expect(m.scrollers, "no box around the table scrolls sideways").toEqual([]);
        expect(m.docScrollWidth, "the page itself does not scroll sideways").toBeLessThanOrEqual(m.innerWidth);
        // The ⋮ of the card's own row takes a real click (nothing covers it).
        await openAppPage(page, `/subscriptions?q=${DOMAIN}`);
        const row = page.locator("main table.table-fixed tbody tr").filter({ hasText: NAME }).first();
        await expect(row).toBeVisible({ timeout: 60_000 });
        await row.getByRole("button", { name: new RegExp(`^Actions for .*${NAME}`) }).click();
        await expect(page.getByRole("menuitem", { name: "Open details" })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }

  for (const [which, id] of [["the part's invoice", INV.now], ["the credited invoice it replaced", INV.old]] as const) {
    test(`Step 2: ${which} (${id}) shows "Open subscription", which opens its drawer`, async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL, "owner");
      try {
        await openAppPage(page, `/invoices/${id}`);
        const card = page.getByTestId("invoice-subscription-card");
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(card).toContainText(PLAN);
        await expect(card).toContainText(DOMAIN);
        await card.getByRole("link", { name: "Open subscription" }).click();
        await expect(page).toHaveURL(new RegExp(`/subscriptions\\?open=${SUB}`), { timeout: 60_000 });
        const drawer = page.getByRole("dialog");
        await expect(drawer).toBeVisible({ timeout: 60_000 });
        await expect(drawer).toContainText(NAME);
      } finally {
        await page.context().close();
      }
    });
  }
});
