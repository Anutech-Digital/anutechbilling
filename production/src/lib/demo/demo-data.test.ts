/** R-201 / R-361: demo data — only on staging/local, every row tagged, a spread worth testing. */
import { describe, it, expect } from "vitest";
import {
  demoDataAllowed, demoRows, gstOn, DEMO_PREFIX, DEMO_ID_PREFIX, DEMO_EMAIL_DOMAIN,
  DEMO_TAG_COLUMN, DEMO_INSERT_ORDER, DEMO_CLEAR_ORDER, DEMO_CLEARED_INDIRECTLY,
  type DemoBundle, type DemoTable,
} from "./demo-data";

const TODAY = "2026-10-07";
function bundle(tenantStateCode: string | null = "07"): DemoBundle {
  let n = 0;
  return demoRows({ today: TODAY, stamp: 1, tenantStateCode, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
}
const daysFromToday = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000);

describe("demoDataAllowed", () => {
  it("is staging and local only — a production build (\"\") or anything else is refused", () => {
    expect(demoDataAllowed("staging")).toBe(true);
    expect(demoDataAllowed("local")).toBe(true);
    expect(demoDataAllowed("")).toBe(false);
    expect(demoDataAllowed(undefined)).toBe(false);
    expect(demoDataAllowed("production")).toBe(false);
  });
});

describe("demoRows — every module, every row tagged", () => {
  const b = bundle();

  it("fills every module the tester listed", () => {
    for (const t of DEMO_INSERT_ORDER) expect(b[t].length, t).toBeGreaterThan(0);
  });

  it("every row of every table carries DEMO · in its tag column", () => {
    for (const t of DEMO_INSERT_ORDER) {
      for (const row of b[t] as unknown as Record<string, unknown>[]) {
        expect(String(row[DEMO_TAG_COLUMN[t]]), `${t}.${DEMO_TAG_COLUMN[t]}`).toMatch(/^DEMO · /);
      }
    }
  });

  it("ids the app mints itself start with DEMO- (never a GST series number)", () => {
    for (const t of ["items", "quotes", "invoices", "vendor_bills", "expenses"] as const) {
      for (const row of b[t]) expect(row.id.startsWith(DEMO_ID_PREFIX), `${t} ${row.id}`).toBe(true);
    }
    expect(b.invoices.every((v) => v.id.startsWith("DEMO-INV-"))).toBe(true);
    expect(b.quotes.every((q) => q.id.startsWith("DEMO-Q-"))).toBe(true);
  });

  it("ids are unique within each table", () => {
    for (const t of DEMO_INSERT_ORDER) {
      const ids = (b[t] as { id: string }[]).map((r) => r.id);
      expect(new Set(ids).size, t).toBe(ids.length);
    }
  });

  it("nobody can be contacted: every email on example.invalid, no phone anywhere", () => {
    const json = JSON.stringify(b);
    const emails = json.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(10);
    for (const e of emails) expect(e.endsWith(`@${DEMO_EMAIL_DOMAIN}`), e).toBe(true);
    for (const t of ["customers", "leads", "vendors"] as const) {
      for (const r of b[t]) expect(r.contact_phone).toBeNull();
    }
    expect(json).not.toMatch(/\+91\d{10}|\+44\d+/);
  });

  it("foreign keys point at rows in the same bundle", () => {
    const cust = new Set(b.customers.map((c) => c.id));
    const lead = new Set(b.leads.map((l) => l.id));
    const quote = new Set(b.quotes.map((q) => q.id));
    const item = new Set(b.items.map((i) => i.id));
    const vend = new Set(b.vendors.map((v) => v.id));
    for (const q of b.quotes) {
      expect(cust.has(q.customer_id)).toBe(true);
      if (q.lead_id) expect(lead.has(q.lead_id)).toBe(true);
      for (const l of q.line_items) expect(item.has(l.item_id)).toBe(true);
    }
    for (const s of b.subscriptions) { expect(cust.has(s.customer_id)).toBe(true); if (s.quote_id) expect(quote.has(s.quote_id)).toBe(true); }
    for (const v of b.invoices) { expect(cust.has(v.customer_id)).toBe(true); if (v.quote_id) expect(quote.has(v.quote_id)).toBe(true); }
    for (const p of b.payments) { expect(quote.has(p.quote_id)).toBe(true); expect(cust.has(p.customer_id)).toBe(true); }
    for (const t of b.tasks) {
      // tasks_one_link_only
      expect([t.customer_id, t.lead_id].filter(Boolean)).toHaveLength(1);
      if (t.customer_id) expect(cust.has(t.customer_id)).toBe(true);
      if (t.lead_id) expect(lead.has(t.lead_id)).toBe(true);
    }
    for (const vb of b.vendor_bills) expect(vend.has(vb.vendor_id)).toBe(true);
    for (const e of b.expenses) if (e.vendor_id) expect(vend.has(e.vendor_id)).toBe(true);
    // A demo customer's name is copied, so the tag on quotes/subs/invoices is the customer's.
    for (const r of [...b.quotes, ...b.subscriptions, ...b.invoices]) {
      expect(b.customers.find((c) => c.id === r.customer_id)?.name).toBe(r.customer_name);
    }
  });
});

describe("demoRows — the spread Today, Renewals and Dunning need", () => {
  const b = bundle();

  it("GST cases on customers: in-state, other state, no GSTIN, no state, export", () => {
    const c = b.customers;
    expect(c.some((x) => x.state_code === "07" && x.gstin)).toBe(true);
    expect(c.some((x) => x.state_code && !x.gstin)).toBe(true);
    expect(c.some((x) => x.country === "India" && !x.state_code)).toBe(true);
    expect(c.some((x) => x.country !== "India")).toBe(true);
  });

  it("a deal in every stage, never a ₹0 value", () => {
    expect(new Set(b.leads.map((l) => l.stage))).toEqual(new Set(["new", "contact", "demo", "trial", "quote", "won", "lost"]));
    for (const l of b.leads) expect(l.value === null || l.value > 0).toBe(true);
  });

  it("a quote in every status", () => {
    expect(new Set(b.quotes.map((q) => q.status))).toEqual(new Set(["draft", "sent", "viewed", "accepted", "rejected", "expired"]));
    const expired = b.quotes.find((q) => q.status === "expired");
    expect(daysFromToday(expired?.expires_date ?? TODAY)).toBeLessThan(0);
  });

  it("renewals due within 7 and within 30 days, one past its date, some far out", () => {
    const d = b.subscriptions.map((s) => daysFromToday(s.renewal_date));
    expect(d.some((x) => x >= 0 && x <= 7)).toBe(true);
    expect(d.some((x) => x > 7 && x <= 30)).toBe(true);
    expect(d.some((x) => x < 0)).toBe(true);
    expect(d.some((x) => x > 90)).toBe(true);
    for (const s of b.subscriptions) expect(daysFromToday(s.start_date)).toBeLessThan(daysFromToday(s.renewal_date));
  });

  it("invoices: paid, overdue (two depths), not yet due — dates agree with status", () => {
    const by = (s: string) => b.invoices.filter((v) => v.status === s);
    expect(by("paid")).toHaveLength(1);
    expect(by("overdue").length).toBeGreaterThanOrEqual(2);
    expect(by("pending")).toHaveLength(1);
    for (const v of by("overdue")) {
      expect(daysFromToday(v.due_date)).toBeLessThan(0);
      expect(v.overdue_days).toBe(-daysFromToday(v.due_date));
      expect(v.paid_amount).toBe(0);
    }
    expect(new Set(by("overdue").map((v) => v.overdue_days)).size).toBeGreaterThan(1);
    expect(daysFromToday(by("pending")[0].due_date)).toBeGreaterThan(0);
    expect(by("paid")[0].paid_amount).toBe(by("paid")[0].amount);
  });

  it("tasks: one overdue, some today, some later, one done", () => {
    const istDay = (at: string) => new Date(Date.parse(at) + 330 * 60_000).toISOString().slice(0, 10);
    const open = b.tasks.filter((t) => t.status === "pending");
    expect(open.some((t) => istDay(t.due_at) < TODAY)).toBe(true);
    expect(open.filter((t) => istDay(t.due_at) === TODAY).length).toBeGreaterThanOrEqual(2);
    expect(open.some((t) => istDay(t.due_at) > TODAY)).toBe(true);
    expect(b.tasks.some((t) => t.status === "done" && t.completed_at)).toBe(true);
  });

  it("payments: one in full, one part — the quote's payment_status agrees", () => {
    const [full, part] = b.payments;
    const q0 = b.quotes.find((q) => q.id === full.quote_id);
    const q1 = b.quotes.find((q) => q.id === part.quote_id);
    expect(full.amount).toBe(q0?.amount);
    expect(q0?.payment_status).toBe("received");
    expect(part.amount).toBeLessThan(q1?.amount ?? 0);
    expect(q1?.payment_status).toBe("partial");
  });
});

describe("demoRows — money in whole rupees, GST 18% right", () => {
  it("gstOn: tax rounded once, total = taxable + tax", () => {
    expect(gstOn(1000)).toEqual({ tax: 180, total: 1180 });
    expect(gstOn(1633)).toEqual({ tax: 294, total: 1927 });
  });

  it("every money field is a whole number of rupees, none negative", () => {
    const money = new Set(["amount", "subtotal", "total_cost", "taxable_value", "tax_amount", "paid_amount", "mrr",
      "outstanding_amount", "msrp", "wholesale", "rate", "list_rate", "cost", "cgst", "sgst", "igst", "total", "gst_paid", "value"]);
    let seen = 0;
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (money.has(k) && v !== null) {
            seen++;
            expect(Number.isInteger(v), k).toBe(true);
            expect(v as number, k).toBeGreaterThanOrEqual(0);
          }
          walk(v);
        }
      }
    };
    walk(bundle());
    expect(seen).toBeGreaterThan(50);
  });

  it("quotes and invoices: amount = subtotal + 18% (rounded once), lines × rate = subtotal", () => {
    const b = bundle();
    for (const q of b.quotes) {
      expect(q.line_items.reduce((s, l) => s + l.qty * l.rate, 0)).toBe(q.subtotal);
      expect(q.amount).toBe(gstOn(q.subtotal).total);
    }
    for (const v of b.invoices) {
      expect(v.taxable_value + v.tax_amount).toBe(v.amount);
      expect(v.tax_amount).toBe(gstOn(v.taxable_value).tax);
      expect(v.line_items.reduce((s, l) => s + l.qty * l.rate, 0)).toBe(v.taxable_value);
    }
  });

  it("IGST vs CGST+SGST follows the workspace's state", () => {
    const delhi = bundle("07");
    const delhiCust = delhi.customers.find((c) => c.state_code === "07");
    expect(delhi.invoices.find((v) => v.customer_id === delhiCust?.id)?.inter_state).toBe(false);
    expect(delhi.invoices.filter((v) => v.customer_id !== delhiCust?.id).every((v) => v.inter_state)).toBe(true);
    // The distributor is in Karnataka: IGST for a Delhi workspace, CGST+SGST for a Karnataka one.
    for (const vb of delhi.vendor_bills) { expect(vb.igst).toBe(vb.total - vb.subtotal); expect(vb.cgst + vb.sgst).toBe(0); }
    for (const vb of bundle("29").vendor_bills) { expect(vb.igst).toBe(0); expect(vb.cgst + vb.sgst).toBe(vb.total - vb.subtotal); }
    // No workspace state known → never guess intra-state.
    expect(bundle(null).invoices.every((v) => v.inter_state)).toBe(true);
  });

  it("expenses hold the amount EX-GST with the GST beside it", () => {
    for (const e of bundle().expenses) {
      expect(e.gst_paid).toBe(e.cgst + e.sgst + e.igst);
      expect(e.gst_paid).toBe(e.bill_type === "gst" ? gstOn(e.amount).tax : 0);
    }
  });
});

describe("the clear plan covers every table written", () => {
  it("every inserted table is in DEMO_CLEAR_ORDER, plus the contacts the leads trigger makes", () => {
    for (const t of DEMO_INSERT_ORDER) expect(DEMO_CLEAR_ORDER, t).toContain(t);
    expect(DEMO_CLEAR_ORDER).toContain("contacts");
  });

  it("children are cleared before the parents they point at", () => {
    const at = (t: DemoTable) => DEMO_CLEAR_ORDER.indexOf(t);
    // customers is ON DELETE RESTRICT from quotes, subscriptions and invoices
    for (const child of ["invoices", "quotes", "subscriptions", "tasks", "payments", "leads", "contacts"] as const) {
      expect(at(child), child).toBeLessThan(at("customers"));
    }
    expect(at("payments")).toBeGreaterThan(at("quotes"));      // they go by cascade from quotes
    expect(at("subscriptions")).toBeLessThan(at("items"));     // (tenant_id, item_id) → items
    expect(at("vendor_bills")).toBeLessThan(at("vendors"));
    expect(at("expenses")).toBeLessThan(at("vendors"));
  });

  it("only invoices (RPC) and payments (cascade from their quote) are cleared indirectly", () => {
    expect(DEMO_CLEARED_INDIRECTLY).toEqual({ invoices: "rpc", payments: "cascade" });
  });

  it("parents are inserted before children", () => {
    const at = (t: keyof DemoBundle) => DEMO_INSERT_ORDER.indexOf(t);
    expect(at("customers")).toBeLessThan(at("quotes"));
    expect(at("quotes")).toBeLessThan(at("payments"));
    expect(at("quotes")).toBeLessThan(at("invoices"));
    expect(at("items")).toBeLessThan(at("subscriptions"));
    expect(at("vendors")).toBeLessThan(at("vendor_bills"));
    expect(at("leads")).toBeLessThan(at("tasks"));
  });

  it("the prefix is the one R-362 audited", () => {
    expect(DEMO_PREFIX).toBe("DEMO · ");
  });
});
