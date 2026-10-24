/**
 * R-1753 — reading Zoho in resumable, paced steps. Zoho is never called: fetch is a fake
 * that answers like Zoho Books (India DC). Made-up T- data only.
 */
import { describe, expect, it } from "vitest";
import { scanStep, contactFromZoho, invoiceFromZoho, linesFromZoho, type ScanRecord, type ScanRun, type ScanStore } from "./import-scan";
import { buildImportPlan } from "./import-plan";
import type { ZohoLineRec } from "./import-plan";

function memoryStore(run: ScanRun) {
  const records = { contact: new Map<string, ScanRecord>(), invoice: new Map<string, ScanRecord & { lines?: ZohoLineRec[] }>() };
  const saved: Array<Record<string, unknown>> = [];
  const store: ScanStore = {
    async saveRun(patch) { saved.push(patch); Object.assign(run, patch); },
    async upsertRecords(kind, rows) {
      for (const r of rows) records[kind].set(r.zoho_id, { ...(records[kind].get(r.zoho_id) ?? {}), ...r });
    },
    async pendingDetails(limit) {
      return [...records.invoice.values()].filter((r) => r.needs_detail && !r.lines).map((r) => r.zoho_id).sort().slice(0, limit);
    },
    async countPendingDetails() { return [...records.invoice.values()].filter((r) => r.needs_detail && !r.lines).length; },
    async saveLines(id, lines) { records.invoice.get(id)!.lines = lines; },
  };
  return { store, records, saved };
}

const CONTACTS = [
  [
    { contact_id: "c1", contact_name: "T-Alpha Pvt Ltd", contact_type: "customer", gst_no: "", gst_treatment: "business_none", place_of_contact: "DL",
      payment_terms: 15, email: "t-ravi@t-alpha.example", first_name: "T-Ravi", last_name: "", customer_sub_type: "business" },
    { contact_id: "v1", contact_name: "T-Vendor", contact_type: "vendor" },
  ],
  [{ contact_id: "c2", contact_name: "T-Beta", contact_type: "customer", customer_sub_type: "individual" }],
];
const INVOICES = [
  { invoice_id: "i1", invoice_number: "INV-T-001", date: "2026-04-01", due_date: "2026-04-15", customer_id: "c1", customer_name: "T-Alpha Pvt Ltd",
    status: "paid", total: 10620, balance: 0, currency_code: "INR", cf_subs_period: "Yearly", custom_fields: [{ label: "New Business?", value: "New" }] },
  { invoice_id: "i2", invoice_number: "INV-T-002", date: "2026-05-01", customer_id: "c1", customer_name: "T-Alpha Pvt Ltd",
    status: "paid", total: 500, balance: 0, cf_subs_period: "One-Time" },
  { invoice_id: "i3", invoice_number: "INV-T-003", date: "2020-01-10", due_date: "2020-01-25", customer_id: "c2", customer_name: "T-Beta",
    status: "overdue", total: 1180, balance: 1180 },
  { invoice_id: "i4", invoice_number: "INV-T-004", date: "2021-01-10", customer_id: "c2", customer_name: "T-Beta", status: "paid", total: 100, balance: 0 },
  { invoice_id: "i5", invoice_number: "INV-T-005", date: "2026-06-01", customer_id: "c2", customer_name: "T-Beta", status: "void", total: 100, balance: 100 },
];
const DETAIL: Record<string, unknown> = {
  i1: { invoice: { invoice_id: "i1", line_items: [{ name: "Google Workspace Business Starter", quantity: 5, rate: 1800, item_total: 9000,
    description: "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)" }] } },
};

/** A fake Zoho Books: contacts in 2 pages, invoices in 1, details by id. Counts calls. */
function fakeZoho(opts: { limitAfter?: number } = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname + (u.searchParams.get("page") ? `?page=${u.searchParams.get("page")}` : ""));
    expect(u.host).toBe("www.zohoapis.in");
    expect(u.searchParams.get("organization_id")).toBe("60000001");
    if (opts.limitAfter !== undefined && calls.length > opts.limitAfter) {
      return new Response(JSON.stringify({ code: 44, message: "too many" }), { status: 429 });
    }
    const page = Number(u.searchParams.get("page") ?? "1");
    if (u.pathname.endsWith("/contacts")) {
      return Response.json({ code: 0, contacts: CONTACTS[page - 1] ?? [], page_context: { has_more_page: page < CONTACTS.length } });
    }
    if (u.pathname.endsWith("/invoices")) {
      return Response.json({ code: 0, invoices: INVOICES, page_context: { has_more_page: false } });
    }
    const id = u.pathname.split("/").pop()!;
    return Response.json({ code: 0, ...(DETAIL[id] as object ?? { invoice: { line_items: [] } }) });
  }) as typeof fetch;
  return { f, calls };
}

const newRun = (): ScanRun => ({
  id: "run-1", org_id: "60000001", since: "2024-10-22", phase: "contacts", next_page: 1,
  contacts_read: 0, invoices_read: 0, details_total: 0, details_done: 0,
});
const instant = { sleep: async () => undefined };

describe("scanStep", () => {
  it("reads contacts (customers only), the right invoices, then their lines → ready; the plan finds the owner's subscription", async () => {
    const run = newRun();
    const { store, records } = memoryStore(run);
    const { f, calls } = fakeZoho();
    const r = await scanStep(run, { store, token: "t", fetch: f, ...instant });
    expect(r.run.phase).toBe("ready");
    expect([...records.contact.keys()]).toEqual(["c1", "c2"]);
    // window invoice + old open invoice kept; old paid and void dropped; One-Time needs no lines
    expect([...records.invoice.keys()].sort()).toEqual(["i1", "i2", "i3"]);
    expect(records.invoice.get("i2")!.needs_detail).toBe(false);
    expect(records.invoice.get("i3")!.needs_detail).toBe(false);
    expect(calls).toEqual(["/books/v3/contacts?page=1", "/books/v3/contacts?page=2", "/books/v3/invoices?page=1", "/books/v3/invoices/i1"]);
    expect(run).toMatchObject({ phase: "ready", contacts_read: 2, invoices_read: 5, details_total: 1, details_done: 1 });

    const plan = buildImportPlan({
      contacts: [...records.contact.values()].map((x) => x.data as never),
      invoices: [...records.invoice.values()].map((x) => ({ ...(x.data as object), lines: x.lines ?? null }) as never),
      existingCustomers: [], existingSubscriptions: [], items: [], existingInvoiceNumbers: new Set(),
      today: "2026-10-22", since: run.since,
    });
    expect(plan.subscriptions).toEqual([expect.objectContaining({ domain: "t-alpha.in", seats: 5, mrr: 750, renewal_date: "2027-03-31" })]);
    expect(plan.invoices).toEqual([expect.objectContaining({ number: "INV-T-003", balance: 1180, zoho_customer_id: "c2" })]);
    expect(plan.counts.customersNew).toBe(2);
  });

  it("stops at its request budget and resumes from the saved cursor", async () => {
    const run = newRun();
    const { store } = memoryStore(run);
    const { f, calls } = fakeZoho();
    const a = await scanStep(run, { store, token: "t", fetch: f, ...instant, maxRequests: 1 });
    expect(a.run).toMatchObject({ phase: "contacts", next_page: 2 });
    const b = await scanStep({ ...run }, { store, token: "t", fetch: f, ...instant, maxRequests: 1 });
    expect(b.run.phase).toBe("invoices");
    await scanStep({ ...run }, { store, token: "t", fetch: f, ...instant, maxRequests: 1 });
    const d = await scanStep({ ...run }, { store, token: "t", fetch: f, ...instant, maxRequests: 1 });
    expect(d.run.phase).toBe("ready");
    expect(calls).toHaveLength(4); // nothing read twice
  });

  it("paces calls at least gapMs apart (Zoho's ~100 a minute)", async () => {
    const run = newRun();
    const { store } = memoryStore(run);
    const { f } = fakeZoho();
    let clock = 0;
    const waits: number[] = [];
    await scanStep(run, { store, token: "t", fetch: f, gapMs: 650, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    expect(waits).toEqual([650, 650, 650]);
  });

  it("Zoho's 'too many requests' pauses the step without losing progress", async () => {
    const run = newRun();
    const { store, saved } = memoryStore(run);
    const { f } = fakeZoho({ limitAfter: 2 });
    const r = await scanStep(run, { store, token: "t", fetch: f, ...instant });
    expect(r.rateLimited).toBe(true);
    expect(run).toMatchObject({ phase: "invoices", next_page: 1, contacts_read: 2 });
    expect(saved.at(-1)?.last_error).toMatch(/limiting requests/);
  });
});

describe("Zoho rows → records", () => {
  it("vendors are left out; person, phone and custom fields are read", () => {
    expect(contactFromZoho({ contact_id: "v", contact_name: "T-V", contact_type: "vendor" })).toBeNull();
    expect(contactFromZoho(CONTACTS[0][0])).toMatchObject({ zohoId: "c1", personName: "T-Ravi", paymentTermsDays: 15, placeOfContact: "DL", gstin: null });
    expect(invoiceFromZoho(INVOICES[0])).toMatchObject({ subsPeriod: "Yearly", newBusiness: "New", serviceExpiry: null, total: 10620 });
    expect(linesFromZoho((DETAIL.i1 as { invoice: Record<string, unknown> }).invoice)[0]).toMatchObject({ plan: "Google Workspace Business Starter", quantity: 5, itemTotal: 9000 });
  });
});
