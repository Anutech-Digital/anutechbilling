/**
 * R-421 — AI Help data tools: tenant scoping, role gate, the numbers and their ₹ formatting.
 * A small in-memory PostgREST stand-in applies the same filters the tools send, so a row of
 * another tenant is really filtered (not just "a filter was called").
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  runHelpDataTools, parseToolRequest, helpToolAllowed, withToolLinks, toolFallbackAnswer,
  helpDataToolsPrompt, NOT_ALLOWED, type HelpToolResult,
} from "./help-data-tools";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
/** 7 Oct 2026, 10:00 IST */
const NOW = new Date("2026-10-07T04:30:00Z");

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

function fakeClient(tables: Record<string, Row[]>, opts: { failTable?: string } = {}) {
  const log: { table: string; filters: Filter[] }[] = [];
  const client = {
    from(table: string) {
      const filters: Filter[] = [];
      const sorts: [string, boolean][] = [];
      let head = false;
      let range: [number, number] | null = null;
      let lim: number | null = null;
      log.push({ table, filters });
      const run = () => {
        if (opts.failTable === table) return { data: null, error: { message: "boom" }, count: null };
        let rows = (tables[table] ?? []).filter((r) => filters.every(([op, c, v]) => {
          const x = r[c];
          if (op === "eq") return x === v;
          if (op === "in") return (v as unknown[]).includes(x);
          if (op === "is") return x == null;
          if (op === "lt") return x != null && (x as string) < (v as string);
          if (op === "notin") return !(v as unknown[]).includes(x);
          return true;
        }));
        for (const [c, asc] of [...sorts].reverse()) {
          rows = [...rows].sort((p, q) => {
            const a = p[c] as string | number | null, b = q[c] as string | number | null;
            if (a === b) return 0;
            if (a == null) return 1;
            if (b == null) return -1;
            return (a < b ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (lim != null) rows = rows.slice(0, lim);
        return { data: head ? null : rows, error: null, count: rows.length };
      };
      const q = {
        select(_c: string, o?: { head?: boolean }) { head = !!o?.head; return q; },
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return q; },
        in(c: string, v: unknown[]) { filters.push(["in", c, v]); return q; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return q; },
        lt(c: string, v: unknown) { filters.push(["lt", c, v]); return q; },
        not(c: string, op: string, v: string) {
          if (op === "in") filters.push(["notin", c, v.replace(/[()]/g, "").split(",")]);
          return q;
        },
        order(c: string, o?: { ascending?: boolean }) { sorts.push([c, o?.ascending !== false]); return q; },
        range(f: number, t: number) { range = [f, t]; return q; },
        limit(n: number) { lim = n; return q; },
        then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, log };
}

const one = async (tables: Record<string, Row[]>, tool: Parameters<typeof runHelpDataTools>[2][number], role = "owner") => {
  const f = fakeClient(tables);
  const [r] = await runHelpDataTools(f.client, { tenantId: A, role, now: NOW }, [tool]);
  return { r, log: f.log };
};

describe("active_subscriptions", () => {
  const subs: Row[] = [
    { id: "1", tenant_id: A, status: "active", renewal_date: "2027-03-01", mrr: 100000 },
    { id: "2", tenant_id: A, status: "active", renewal_date: "2026-10-20", mrr: 250000 },
    { id: "3", tenant_id: A, status: "active", renewal_date: null, mrr: 5000 },
    { id: "4", tenant_id: A, status: "paused", renewal_date: "2027-01-01", mrr: 7000 },
    { id: "5", tenant_id: B, status: "active", renewal_date: "2027-01-01", mrr: 9_999_999 },
  ];

  it("counts only this tenant's active subscriptions and sums their MRR in Indian grouping", async () => {
    const { r, log } = await one({ subscriptions: subs }, "active_subscriptions");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("Active subscriptions: 3. MRR: ₹3,55,000 a month.");
    expect(r.href).toBe("/subscriptions?focus=active");
    expect(log.length).toBeGreaterThan(0);
    for (const q of log) expect(q.filters).toContainEqual(["eq", "tenant_id", A]);
  });

  it("formats crores with lakh/crore commas", async () => {
    const { r } = await one({ subscriptions: [{ id: "1", tenant_id: A, status: "active", renewal_date: null, mrr: 12_345_678 }] }, "active_subscriptions");
    expect(r.text).toContain("₹1,23,45,678");
  });
});

describe("renewals_due", () => {
  it("lists the next 30 days (and the lapsed) soonest first, this tenant only", async () => {
    const { r } = await one({
      subscriptions: [
        { id: "1", tenant_id: A, customer_name: "Acme", plan: "Business Starter", status: "active", renewal_date: "2026-10-10" },
        { id: "2", tenant_id: A, customer_name: "Bolt", plan: "M365 Basic", status: "active", renewal_date: "2026-10-01" },
        { id: "3", tenant_id: A, customer_name: "Far", plan: "X", status: "active", renewal_date: "2026-12-31" },
        { id: "4", tenant_id: A, customer_name: "Gone", plan: "X", status: "cancelled", renewal_date: "2026-10-09" },
        { id: "5", tenant_id: B, customer_name: "OtherCo", plan: "X", status: "active", renewal_date: "2026-10-08" },
      ],
    }, "renewals_due");
    expect(r.text.split("\n")[0]).toBe("Renewals due in the next 30 days: 2 (1 already past the renewal date).");
    expect(r.text).toMatch(/- Bolt — M365 Basic — .* \(6 days late\)\n- Acme — Business Starter — .* \(in 3 days\)/);
    expect(r.text).not.toContain("OtherCo");
    expect(r.text).not.toContain("Gone");
  });
});

describe("overdue_invoices", () => {
  it("counts past-due unpaid invoices and what is still owed on them", async () => {
    const { r } = await one({
      invoices: [
        { id: "1", tenant_id: A, status: "pending", due_date: "2026-10-01", amount: 118000, net_payable: null, paid_amount: 18000 },
        { id: "2", tenant_id: A, status: "pending", due_date: "2026-10-30", amount: 5000, net_payable: null, paid_amount: 0 },
        { id: "3", tenant_id: A, status: "paid", due_date: "2026-09-01", amount: 7000, net_payable: null, paid_amount: 7000 },
        { id: "4", tenant_id: B, status: "pending", due_date: "2026-09-01", amount: 999999, net_payable: null, paid_amount: 0 },
      ],
    }, "overdue_invoices", "billing");
    expect(r.text).toBe("Overdue invoices: 1. Still owed on them: ₹1,00,000.");
    expect(r.href).toBe("/invoices?tab=overdue");
  });
});

describe("todays_followups / open_quotes / leads_by_stage", () => {
  const leads: Row[] = [
    { id: "1", tenant_id: A, is_junk: false, stage: "contact", follow_up_date: "2026-10-07", company: "Today Co", value: 10 },
    { id: "2", tenant_id: A, is_junk: false, stage: "demo", follow_up_date: "2026-10-03", company: "Late Co", value: 5 },
    { id: "3", tenant_id: A, is_junk: true, stage: "new", follow_up_date: "2026-10-07", company: "Junk", value: 1 },
    { id: "4", tenant_id: A, is_junk: false, stage: "won", follow_up_date: "2026-10-07", company: "Won Co", value: 1 },
    { id: "5", tenant_id: B, is_junk: false, stage: "new", follow_up_date: "2026-10-07", company: "Other", value: 1 },
  ];

  it("follow-ups due today and overdue, open non-junk leads of this tenant", async () => {
    const { r } = await one({ leads }, "todays_followups", "sales");
    expect(r.text).toBe("Follow-ups due today: 1. Already overdue (earlier dates): 1.\n- Today Co");
  });

  it("open quotes: draft/sent/viewed and not invoiced, with total value", async () => {
    const { r } = await one({
      quotes: [
        { id: "Q1", tenant_id: A, status: "sent", amount: 250000, invoice_id: null },
        { id: "Q2", tenant_id: A, status: "draft", amount: 50000, invoice_id: null },
        { id: "Q3", tenant_id: A, status: "accepted", amount: 70000, invoice_id: null },
        { id: "Q4", tenant_id: A, status: "viewed", amount: 1000, invoice_id: "INV-1" },
        { id: "Q5", tenant_id: B, status: "sent", amount: 8_000_000, invoice_id: null },
      ],
    }, "open_quotes", "manager");
    expect(r.text).toBe("Open quotes: 2 (draft 1, sent 1, viewed 0). Total value: ₹3,00,000.");
  });

  it("leads by stage, junk left out", async () => {
    const { r } = await one({ leads }, "leads_by_stage", "owner");
    expect(r.text).toBe("Open leads: 2 leads. By stage: new 0, contact 1, demo 1, trial 0, quote 0, won 1, lost 0.");
  });
});

describe("role gate", () => {
  it("a role that cannot open the page gets 'not allowed' and nothing is read", async () => {
    const f = fakeClient({ subscriptions: [{ id: "1", tenant_id: A, status: "active", mrr: 100 }] });
    const res = await runHelpDataTools(f.client, { tenantId: A, role: "sales", now: NOW }, ["active_subscriptions", "overdue_invoices"]);
    expect(res.map((r) => r.ok)).toEqual([false, false]);
    expect(res[0].text).toContain(NOT_ALLOWED);
    expect(res[0].href).toBeNull();
    expect(f.log).toHaveLength(0);
  });

  it("follows the menu: billing sees money pages but not Quotes; accountant reads invoices; unknown role nothing", () => {
    expect(helpToolAllowed("billing", "active_subscriptions")).toBe(true);
    expect(helpToolAllowed("billing", "overdue_invoices")).toBe(true);
    expect(helpToolAllowed("billing", "open_quotes")).toBe(false);
    expect(helpToolAllowed("accountant", "overdue_invoices")).toBe(true);
    expect(helpToolAllowed("sales", "todays_followups")).toBe(true);
    expect(helpToolAllowed("sales", "active_subscriptions")).toBe(false);
    expect(helpToolAllowed(null, "leads_by_stage")).toBe(false);
    expect(helpToolAllowed("hacker", "leads_by_stage")).toBe(false);
  });
});

describe("failures and plumbing", () => {
  it("a failed read is reported, never thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeClient({}, { failTable: "invoices" });
    const [r] = await runHelpDataTools(f.client, { tenantId: A, role: "owner", now: NOW }, ["overdue_invoices"]);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("could not be read");
    err.mockRestore();
  });

  it("parseToolRequest keeps known names, no repeats, at most 3", () => {
    expect(parseToolRequest({ tools: ["active_subscriptions", "drop_table", "active_subscriptions", "open_quotes", "leads_by_stage", "renewals_due"] }))
      .toEqual(["active_subscriptions", "open_quotes", "leads_by_stage"]);
    expect(parseToolRequest({ reply: "hi" })).toEqual([]);
    expect(parseToolRequest(null)).toEqual([]);
  });

  it("answers carry the link to the number's page, deduped, max 3", () => {
    const res: HelpToolResult[] = [{ tool: "active_subscriptions", ok: true, text: "x", href: "/subscriptions?focus=active", label: "Open active subscriptions" }];
    const a = withToolLinks({ reply: "3", bugDraft: null, checklist: [], actions: [], followUps: [] }, res);
    expect(a.actions).toEqual([{ kind: "open", label: "Open active subscriptions", href: "/subscriptions?focus=active" }]);
    const b = withToolLinks({ reply: "3", bugDraft: null, checklist: [], actions: [{ kind: "open", label: "Subs", href: "/subscriptions" }], followUps: [] }, res);
    expect(b.actions).toHaveLength(1);
    expect(toolFallbackAnswer(res).reply).toBe("x");
  });

  it("the prompt lists every tool", () => {
    const p = helpDataToolsPrompt();
    for (const n of ["active_subscriptions", "renewals_due", "overdue_invoices", "todays_followups", "open_quotes", "leads_by_stage"]) expect(p).toContain(n);
  });
});
