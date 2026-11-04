import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────────
   R-2456 — the inbound auto-quote sender runs the same customer-copy gate as Send.

   R-2448 put the "no place of supply" rule into customerCopyBlock for every MANUAL path
   (Send, Mark as sent, the PDF link, the quote page's buttons). The auto-quote sender —
   an enquiry email or the website form drafts a quote on a LEAD and emails it with no
   person present — still mailed it: a GST quote with no state reached the customer, and
   CGST + SGST vs IGST stays undecided until generate_invoice refuses after payment.

   Owner's real path: a lead arrives with no state, the AI drafts a quote, decideAutoSend
   says yes → today the mail goes. Now: no email, the quote stays a draft, the lead's
   timeline and the owner's bell say "Auto-quote not sent — set the state" with the link.
   ───────────────────────────────────────────────────────────────────────────── */

const sendCustomerEmail = vi.fn();
const notifyPeople = vi.fn();
const renderQuotePDF = vi.fn();

vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: (...a: unknown[]) => sendCustomerEmail(...a) }));
vi.mock("@/lib/notifications/notify.server", () => ({
  notifyPeople: (...a: unknown[]) => notifyPeople(...a),
}));
vi.mock("@/lib/pdf", () => ({ renderQuotePDF: (...a: unknown[]) => renderQuotePDF(...a) }));
vi.mock("@/lib/pdf/logo", () => ({ logoDataUri: async () => null }));
vi.mock("@/lib/compliance/gst-registration-server", () => ({
  readTenantGstRegistration: async () => ({ registered: true }),
}));

import { sendAutoQuote, autoQuoteHoldFor } from "./send-auto-quote";

type Row = Record<string, unknown>;
interface Write { table: string; op: "insert" | "update"; values: unknown }

/** A tiny supabase-js stand-in: every read of a table returns its row; writes are recorded. */
function fakeAdmin(tables: Record<string, Row | Row[] | null>) {
  const writes: Write[] = [];
  const from = (table: string) => {
    let op: Write["op"] | null = null;
    const result = () => {
      const data = tables[table] ?? null;
      if (op === "update") return { data: [{ id: "x" }], error: null };
      if (op === "insert") return { data: null, error: null };
      return { data, error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "or", "order", "limit"]) b[m] = () => b;
    b.insert = (values: unknown) => { op = "insert"; writes.push({ table, op, values }); return b; };
    b.update = (values: unknown) => { op = "update"; writes.push({ table, op, values }); return b; };
    b.maybeSingle = async () => {
      const r = result();
      return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data };
    };
    b.single = b.maybeSingle;
    b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
    return b;
  };
  return { admin: { from } as never, writes };
}

const QUOTE: Row = {
  id: "Q-TEST-2026-27-0001",
  customer_id: null,
  lead_id: "lead-1",
  invoice_id: null,
  customer_name: "Acme Traders",
  prospect_state_code: null,
  prospect_country: null,
  line_items: [{ description: "Google Workspace Business Starter", qty: 10, rate: 1000, list_rate: 1000, cost: 800 }],
  subtotal: 10000,
  discount_pct: 0,
  tax_rate: 18,
  amount: 11800,
  created_date: "2026-11-04",
  expires_date: "2026-12-04",
  notes: null,
  is_renewal: false,
  is_extension: false,
  extension_months: null,
  status: "draft",
  billing_cycle: "yearly",
  approval_status: null,
  approval_tier: null,
  approval_requested_by: null,
  approved_by: null,
  approved_discount_bps: null,
  approved_margin_bps: null,
  approval_rejection_reason: null,
};
const TENANT: Row = {
  name: "Seller Pvt Ltd", email: "owner@seller.test", phone: null, gstin: "07AAAAA0000A1Z5",
  address: "Delhi", state: "Delhi", state_code: "07", logo_url: null,
};
const ARGS = {
  tenantId: "t-1", quoteId: "Q-TEST-2026-27-0001", leadId: "lead-1",
  recipient: "buyer@acme.test", fromEmail: "sales@seller.test", incomingSubject: "quote please",
};

beforeEach(() => {
  sendCustomerEmail.mockReset().mockResolvedValue({ status: "sent" });
  notifyPeople.mockReset().mockResolvedValue(undefined);
  renderQuotePDF.mockReset().mockResolvedValue(new Blob(["%PDF"]));
});

describe("R-2456 — a lead with no state: the auto-quote is NOT emailed", () => {
  it("sends nothing, keeps the draft, notes the lead and tells the owner with the link", async () => {
    const { admin, writes } = fakeAdmin({
      quotes: QUOTE, tenants: TENANT, user_google_tokens: [],
      leads: { state_code: null, gstin: null, country: "India", stage: "new" },
      customers: null,
    });

    const out = await sendAutoQuote(admin, ARGS);

    expect(out).toMatchObject({ status: "held", kind: "customer_state", quoteId: "Q-TEST-2026-27-0001", href: "/leads?lead=lead-1", totals: [10000, 1800, 11800] });
    expect(sendCustomerEmail).not.toHaveBeenCalled();
    // The quote stays a draft — no status update, no send-log row.
    expect(writes.filter((w) => w.table === "quotes")).toEqual([]);
    expect(writes.filter((w) => w.table === "quote_send_log")).toEqual([]);
    // The lead's timeline says why and what to do.
    const notes = writes.filter((w) => w.table === "lead_activities").map((w) => (w.values as Row).detail as string);
    expect(notes.some((d) => /Auto-quote not sent — set the state/.test(d) && d.includes("Q-TEST-2026-27-0001"))).toBe(true);
    // The owner's bell, with the link that fixes it.
    expect(notifyPeople).toHaveBeenCalledTimes(1);
    const n = notifyPeople.mock.calls[0][0] as Row;
    expect(n.tenantId).toBe("t-1");
    expect(n.title).toMatch(/^Auto-quote not sent — set the state/);
    expect(n.href).toBe("/leads?lead=lead-1");
    expect(n.entityId).toBe("Q-TEST-2026-27-0001");
    expect(n.kind).toBe("quote.not_sent");
    expect(notifyPeople.mock.calls[0][1]).toEqual({ roles: ["owner", "manager"] });
  });

  it("a follow-up re-running the same held draft does not ring the bell twice", async () => {
    const { admin, writes } = fakeAdmin({
      quotes: QUOTE, tenants: TENANT, user_google_tokens: [],
      leads: { state_code: null, gstin: null, country: "India", stage: "new" },
      customers: null,
      notifications: [{ id: "n-1" }], // an unread quote.not_sent for this quote already exists
    });

    expect(await sendAutoQuote(admin, ARGS)).toMatchObject({ status: "held" });
    expect(sendCustomerEmail).not.toHaveBeenCalled();
    expect(notifyPeople).not.toHaveBeenCalled();
    // The timeline still records this attempt.
    expect(writes.some((w) => w.table === "lead_activities" && /Auto-quote not sent/.test(String((w.values as Row).detail)))).toBe(true);
  });

  it("the company's own state missing also stops it — link to Settings → Company", async () => {
    const { admin } = fakeAdmin({
      quotes: QUOTE, tenants: { ...TENANT, state_code: null, gstin: null }, user_google_tokens: [],
      leads: { state_code: "06", gstin: null, country: "India", stage: "new" },
      customers: null,
    });

    const out = await sendAutoQuote(admin, ARGS);

    expect(out).toMatchObject({ status: "held", kind: "company_state" });
    expect(sendCustomerEmail).not.toHaveBeenCalled();
    const n = notifyPeople.mock.calls[0][0] as Row;
    expect(n.title).toMatch(/^Auto-quote not sent — set the company state/);
    expect(String(n.href)).toMatch(/settings/);
    // Only the owner can set the company state — a manager is not sent a fix they cannot do.
    expect(notifyPeople.mock.calls[0][1]).toEqual({ roles: ["owner"] });
  });
});

describe("R-2456 — the approval half of the same gate", () => {
  it("a draft that manual Send would refuse for approval is not emailed either", async () => {
    const { admin } = fakeAdmin({
      quotes: { ...QUOTE, line_items: [{ description: "Starter", qty: 10, rate: 1000, list_rate: 2000, cost: 800 }] },
      tenants: TENANT, user_google_tokens: [],
      leads: { state_code: "06", gstin: null, country: "India", stage: "new" },
      customers: null,
    });

    const out = await sendAutoQuote(admin, ARGS);

    expect(out).toMatchObject({ status: "held", kind: "approval", href: "/quotes/Q-TEST-2026-27-0001" });
    expect(sendCustomerEmail).not.toHaveBeenCalled();
    const n = notifyPeople.mock.calls[0][0] as Row;
    expect(n.title).toMatch(/^Auto-quote not sent — needs approval/);
    expect(n.href).toBe("/quotes/Q-TEST-2026-27-0001");
  });
});

describe("R-2456 — a lead WITH a state: the auto-quote is sent as before", () => {
  it("emails it and marks it sent; no 'not sent' notification", async () => {
    const { admin, writes } = fakeAdmin({
      quotes: QUOTE, tenants: TENANT, user_google_tokens: [],
      leads: { state_code: "06", gstin: null, country: "India", stage: "new" },
      customers: null,
    });

    const out = await sendAutoQuote(admin, ARGS);

    expect(out).toBe("sent");
    expect(sendCustomerEmail).toHaveBeenCalledTimes(1);
    expect(writes.some((w) => w.table === "quotes" && (w.values as Row).status === "sent")).toBe(true);
    expect(notifyPeople).not.toHaveBeenCalled();
    // Haryana buyer, Delhi seller → IGST, printed as such (was a blanket intra-state).
    const pdf = renderQuotePDF.mock.calls[0][0] as Row;
    expect(pdf.interState).toBe(true);
    expect(pdf.placeOfSupply).toBe("Haryana (06) · IGST");
    expect(String((sendCustomerEmail.mock.calls[0][0] as Row).text)).toMatch(/inter-state/);
  });

  it("a same-state lead stays intra-state (CGST + SGST)", async () => {
    const { admin } = fakeAdmin({
      quotes: QUOTE, tenants: TENANT, user_google_tokens: [],
      leads: { state_code: "07", gstin: null, country: "India", stage: "new" },
      customers: null,
    });

    expect(await sendAutoQuote(admin, ARGS)).toBe("sent");
    const pdf = renderQuotePDF.mock.calls[0][0] as Row;
    expect(pdf.interState).toBe(false);
    expect(pdf.placeOfSupply).toBe("Delhi (07) · CGST + SGST");
  });
});

describe("R-2460 — autoQuoteHoldFor: the same gate, asked by the AI sales agent", () => {
  it("a no-state lead's draft is held, with its figures", async () => {
    const { admin, writes } = fakeAdmin({
      quotes: QUOTE, tenants: TENANT,
      leads: { state_code: null, gstin: null, country: "India" }, customers: null,
    });
    const h = await autoQuoteHoldFor(admin, { tenantId: "t-1", leadId: "lead-1", quoteId: "Q-TEST-2026-27-0001" });
    expect(h).toMatchObject({ status: "held", kind: "customer_state", totals: [10000, 1800, 11800] });
    // Only a question — it writes nothing and rings no bell.
    expect(writes).toEqual([]);
    expect(notifyPeople).not.toHaveBeenCalled();
  });

  it("a lead with a state → not held", async () => {
    const { admin } = fakeAdmin({
      quotes: QUOTE, tenants: TENANT,
      leads: { state_code: "06", gstin: null, country: "India" }, customers: null,
    });
    expect(await autoQuoteHoldFor(admin, { tenantId: "t-1", leadId: "lead-1", quoteId: "Q-TEST-2026-27-0001" })).toBeNull();
  });

  it("a sent quote is not a held one", async () => {
    const { admin } = fakeAdmin({
      quotes: { ...QUOTE, status: "sent" }, tenants: TENANT,
      leads: { state_code: null, gstin: null, country: "India" }, customers: null,
    });
    expect(await autoQuoteHoldFor(admin, { tenantId: "t-1", leadId: "lead-1", quoteId: "Q-TEST-2026-27-0001" })).toBeNull();
  });
});
