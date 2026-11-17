/* R-2876 — Status / Last bill in ONE read (renewal_row_facts), with the SAME answer as the old four-trip reads.

   What is proven here, on one fixture read both ways through the page's own readers:
     1. EQUALITY: for every listed subscription, Last docs (quote / invoices / stage inputs) and Last paid are
        deep-equal whether the reads go to PostgREST (old way) or are answered from the one-read answer —
        a together-quote member, a row billed in parts, a row with a credit + debit note, a foreign-currency row,
        a row with no documents, an own quote this login may not read, a released together link, a refund, a void invoice.
     2. TRIPS: the new way is ONE trip and makes no table read at all; the old way needs 4+ (the guard the card lowers).
     3. FALLBACK: function missing (PGRST202) → the old reads, same answer, and it is not asked for again;
        an answer that does not cover a read (a column missing) → thrown away, old reads, same answer.
     4. COVERED OR NOT ANSWERED: the stand-in refuses a read it cannot answer in full.
   The fake `rpc` below mirrors the SQL function's row sets in plain JS; that the real function returns those rows
   (and nothing of another company / role) is supabase/tests/r2876_renewal_row_facts.test.sql, and the same equality
   on the real local database is e2e/cards/R-2876.spec.ts. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let pending: (() => void)[] = [];
let tableReads: string[] = [];
let rpcCalls = 0;
let rpcMode: "ok" | "missing" | "thin" | "error" = "ok";

const byId = (a: Row, b: Row) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
const sorted = (t: string) => [...(tables[t] ?? [])].sort(byId);

/* ── a fake PostgREST that PROJECTS the selected columns (and the quotes(...) embed), like the real one ── */
function project(row: Row, select: string): Row {
  const out: Row = {};
  const embed = /(\w+)\(([^)]*)\)/.exec(select);
  const plain = embed ? select.replace(embed[0], "") : select;
  for (const c of plain.split(",").map((x) => x.trim()).filter(Boolean)) out[c] = row[c] ?? null;
  if (embed) {
    const q = (tables.quotes ?? []).find((x) => x.id === row.quote_id);
    out[embed[1]] = q ? project(q, embed[2]) : null;
  }
  return out;
}
function builder(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let select = "";
  const b = {
    select: (s: string) => { select = s; return b; },
    in: (col: string, ids: unknown[]) => { const set = new Set(ids); filters.push((r) => set.has(r[col])); return b; },
    eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; },
    neq: (col: string, v: unknown) => { filters.push((r) => r[col] != null && r[col] !== v); return b; },
    order: () => b,
    range: (from: number, to: number) => new Promise<{ data: Row[]; error: null }>((resolve) => {
      tableReads.push(table);
      pending.push(() => resolve({ data: sorted(table).filter((r) => filters.every((f) => f(r))).slice(from, to + 1).map((r) => project(r, select)), error: null }));
    }),
  };
  return b;
}

/* ── the function, mirrored (see the migration): row sets only ── */
function rowFacts(subIds: string[], quoteIds: string[]): Row {
  const S = new Set<unknown>(subIds); const asked = new Set<unknown>(quoteIds);
  const has = (v: unknown) => v !== null && v !== undefined;
  const links = sorted("renewal_quote_subscriptions").filter((l) => S.has(l.subscription_id));
  const billings = sorted("subscription_billings").filter((b) => S.has(b.subscription_id));
  const billingIds = new Set(billings.map((b) => b.id)); const linkQuotes = new Set(links.map((l) => l.quote_id));
  const main = sorted("quotes").filter((q) => S.has(q.renewal_subscription_id) || S.has(q.add_seats_subscription_id) || asked.has(q.id) || linkQuotes.has(q.id) || billingIds.has(q.subscription_billing_id));
  const mainIds = new Set(main.map((q) => q.id));
  const mainInvoiceIds = new Set<unknown>([...billings.map((b) => b.invoice_id), ...main.map((q) => q.invoice_id)].filter(has));
  const quoteKeys = new Set<unknown>([...mainIds, ...asked]);
  const invoices = sorted("invoices").filter((i) => mainInvoiceIds.has(i.id) || quoteKeys.has(i.quote_id));
  const invoiceKeys = new Set<unknown>([...mainInvoiceIds, ...invoices.map((i) => i.id)]);
  const extra = sorted("quotes").filter((q) => !mainIds.has(q.id) && invoices.some((i) => i.quote_id === q.id));
  const note = (n: Row) => ({ id: n.id, invoice_id: n.invoice_id, amount: n.amount });
  return {
    quotes: [...main.map((q) => ({ ...q, main: true })), ...extra.map((q) => ({ ...q, main: false }))].sort(byId),
    billings, links, invoices,
    credit_notes: sorted("credit_notes").filter((n) => invoiceKeys.has(n.invoice_id)).map(note),
    debit_notes: sorted("debit_notes").filter((n) => invoiceKeys.has(n.invoice_id)).map(note),
    subscriptions: sorted("subscriptions").filter((s) => quoteKeys.has(s.quote_id)).map((s) => ({ id: s.id, quote_id: s.quote_id })),
    payments: sorted("payments").filter((p) => p.status === "received" && (quoteKeys.has(p.quote_id) || invoiceKeys.has(p.invoice_id))),
    invoice_ids: [...mainInvoiceIds].sort(),
  };
}
function rpc(name: string, args: { p_sub_ids: string[]; p_quote_ids: string[] }) {
  return new Promise<{ data: unknown; error: unknown }>((resolve) => {
    rpcCalls += 1;
    pending.push(() => {
      if (name !== "renewal_row_facts" || rpcMode === "missing") return resolve({ data: null, error: { code: "PGRST202", message: "Could not find the function public.renewal_row_facts(p_quote_ids, p_sub_ids) in the schema cache" } });
      if (rpcMode === "error") return resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
      const facts = rowFacts(args.p_sub_ids, args.p_quote_ids);
      /* "thin": an older function that does not return a column the page now selects */
      if (rpcMode === "thin") facts.invoices = (facts.invoices as Row[]).map(({ fx_rate: _f, ...i }) => i);
      resolve({ data: facts, error: null });
    });
  });
}
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: (t: string) => builder(t), rpc }) }));

import { readRenewalDocRows, docsFromRows, useRenewalLastDocs, RENEWALS_READ_CONCURRENCY } from "./last-docs-data";
import { lastPaidFromDocRows } from "./last-paid-data";
import { factsClient, fetchRenewalRowFacts, readRenewalRowFacts, resetRowFactsForTest, withRowFacts, parseSelect, ROW_FACTS_JOIN_MS, ROW_FACTS_RETRY_MS, type RenewalRowFacts } from "./row-facts-data";

/** Run `work`; answer every request in flight together, again and again — how many trips it took (as in R-2855). */
async function trips<T>(work: () => Promise<T>): Promise<{ value: T; trips: number }> {
  let done = false; let value!: T; let error: unknown;
  work().then((v) => { value = v; done = true; }, (e) => { error = e; done = true; });
  let n = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    if (done) break;
    if (pending.length === 0) continue;
    n += 1;
    const batch = pending; pending = [];
    for (const answer of batch) answer();
  }
  if (error) throw error;
  return { value, trips: n };
}

/* ── the fixture ── */
const quote = (over: Row & { id: string }): Row => ({
  status: "sent", payment_status: "awaiting", created_at: "2026-10-01T05:00:00+00:00", created_date: "2026-10-01", expires_date: "2026-12-31",
  invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null, subscription_billing_id: null, superseded_by: null, revision_of: null,
  amount: 118000, currency: "INR", exchange_rate: null, line_items: [{ name: "Workspace", commitment: "annual_yearly", start_date: "2026-12-01" }],
  is_renewal: false, is_extension: false, is_add_seats: false, is_one_off: false, extension_months: null, renewal_term_date: null, ...over,
});
const invoice = (over: Row & { id: string }): Row => ({
  quote_id: null, invoice_date: "2025-12-01", status: "pending", amount: 118000, paid_amount: 0, currency: "INR", created_at: "2025-12-01T05:00:00+00:00",
  due_date: "2025-12-15", net_payable: null, adjusted_advances: [], written_off_at: null, fx_rate: null, ...over,
});
const payment = (over: Row & { id: string }): Row => ({
  amount: 118000, method: "bank_transfer", status: "received", received_at: "2025-12-05T05:00:00+00:00", refunded_at: null, quote_id: null, invoice_id: null,
  receipt_voucher_no: null, reference: null, ...over,
});
const sub = (id: string, over: Row = {}) => ({ id, quote_id: null as string | null, renewal_quote_id: null as string | null, start_date: "2025-12-01", plan: "Workspace", domain: null, term_months: 12, ...over });

/* one of each case the card names */
const SUBS = [
  sub("s-credit", { quote_id: "Q-CREDIT", renewal_quote_id: "QR-CREDIT" }),      // invoice with a credit + a debit note; renewal quote sent
  sub("s-parts", { quote_id: "Q-PARTS" }),                                        // billed in parts: paid part + open part proforma
  sub("s-tog-a", { quote_id: "Q-TOG-A" }),                                        // member of a together quote (lead)
  sub("s-tog-b", { quote_id: "Q-TOG-B" }),                                        // member of the same together quote
  sub("s-usd", { quote_id: "Q-USD", renewal_quote_id: "QR-USD" }),                // foreign currency
  sub("s-none"),                                                                   // no documents at all
  sub("s-hidden", { quote_id: "Q-HIDDEN" }),                                      // own quote this login may not read; its invoice + payment are visible
  sub("s-seats", { quote_id: "Q-SEATS-ORIG" }),                                   // an add-seats quote, a void invoice, a refund
];

beforeEach(() => {
  pending = []; tableReads = []; rpcCalls = 0; rpcMode = "ok";
  resetRowFactsForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  tables.subscriptions = [
    ...SUBS.map((s) => ({ id: s.id, quote_id: s.quote_id })),
    { id: "s-sibling", quote_id: "Q-CREDIT" },          // made from the same quote ("covers 2 subscriptions")
    { id: "s-unlisted", quote_id: "Q-UNLISTED" },
  ];
  tables.quotes = [
    quote({ id: "Q-CREDIT", status: "accepted", payment_status: "invoiced", created_at: "2025-11-20T05:00:00+00:00", created_date: "2025-11-20", invoice_id: "INV-CREDIT", line_items: [{ name: "Workspace", commitment: "annual_yearly", start_date: "2025-12-01" }] }),
    quote({ id: "QR-CREDIT", renewal_subscription_id: "s-credit", is_renewal: true, renewal_term_date: "2026-12-01" }),
    quote({ id: "QR-CREDIT-OLD", renewal_subscription_id: "s-credit", is_renewal: true, status: "revised", superseded_by: "QR-CREDIT", created_at: "2026-09-20T05:00:00+00:00", created_date: "2026-09-20" }),
    quote({ id: "Q-PARTS", status: "accepted", payment_status: "invoiced", created_at: "2025-11-20T05:00:00+00:00", created_date: "2025-11-20", line_items: [{ name: "Workspace", commitment: "annual_monthly", start_date: "2025-12-01" }] }),
    quote({ id: "QP-1", subscription_billing_id: "b-parts-1", status: "accepted", payment_status: "received", invoice_id: "INV-PART-1", amount: 11800, created_at: "2026-10-25T05:00:00+00:00", created_date: "2026-10-25", line_items: [{ name: "Workspace", billing_id: "b-parts-1" }] }),
    quote({ id: "QP-2", subscription_billing_id: "b-parts-2", amount: 11800, created_at: "2026-11-10T05:00:00+00:00", created_date: "2026-11-10", line_items: [{ name: "Workspace", billing_id: "b-parts-2" }] }),
    quote({ id: "Q-TOG-A", status: "accepted", payment_status: "invoiced", created_at: "2025-11-20T05:00:00+00:00", created_date: "2025-11-20", invoice_id: "INV-TOG-A" }),
    quote({ id: "Q-TOG-B", status: "accepted", payment_status: "invoiced", created_at: "2025-11-20T05:00:00+00:00", created_date: "2025-11-20" }),
    /* the together quote: linked to both members ONLY through renewal_quote_subscriptions */
    quote({ id: "Q-TOGETHER", is_renewal: true, amount: 236000, payment_status: "received", status: "accepted", invoice_id: "INV-TOGETHER", line_items: [{ name: "Workspace A" }, { name: "Workspace B" }] }),
    quote({ id: "Q-TOGETHER-OLD", is_renewal: true, amount: 236000, created_at: "2026-09-01T05:00:00+00:00", created_date: "2026-09-01" }),   // its link was released
    quote({ id: "Q-USD", status: "accepted", payment_status: "invoiced", currency: "USD", exchange_rate: 83.25, amount: 50000, invoice_id: "INV-USD", created_at: "2025-11-20T05:00:00+00:00", created_date: "2025-11-20" }),
    quote({ id: "QR-USD", renewal_subscription_id: "s-usd", is_renewal: true, currency: "USD", exchange_rate: 84.1, amount: 52000, renewal_term_date: "2026-12-01" }),
    /* Q-HIDDEN is NOT in the table: quotes RLS hides it from this login */
    quote({ id: "Q-SEATS-ORIG", status: "accepted", payment_status: "invoiced", created_at: "2025-11-20T05:00:00+00:00", created_date: "2025-11-20", invoice_id: "INV-SEATS-VOID" }),
    quote({ id: "Q-SEATS", add_seats_subscription_id: "s-seats", is_add_seats: true, amount: 23600, status: "accepted", payment_status: "invoiced", invoice_id: "INV-SEATS" }),
    /* an invoice below came from this quote, which is linked to nothing listed: only its lines are needed */
    quote({ id: "Q-SOURCE", status: "accepted", payment_status: "invoiced", created_at: "2026-10-20T05:00:00+00:00", created_date: "2026-10-20", line_items: [{ name: "Workspace", commitment: "annual_monthly", start_date: "2026-11-01" }] }),
    quote({ id: "Q-UNLISTED", renewal_subscription_id: "s-unlisted", invoice_id: "INV-UNLISTED" }),
  ];
  tables.subscription_billings = [
    { id: "b-parts-1", subscription_id: "s-parts", invoice_id: "INV-PART-1", term_start: "2026-12-01", period_index: 1, due_on: "2026-11-01", period_start: "2026-12-01", period_end: "2027-01-01", taxable_amount: 10000 },
    { id: "b-parts-2", subscription_id: "s-parts", invoice_id: null, term_start: "2026-12-01", period_index: 2, due_on: "2026-12-01", period_start: "2027-01-01", period_end: "2027-02-01", taxable_amount: 10000 },
    { id: "b-parts-0", subscription_id: "s-parts", invoice_id: "INV-PART-0", term_start: "2025-12-01", period_index: 1, due_on: "2025-12-01", period_start: "2025-12-01", period_end: "2026-01-01", taxable_amount: 10000 },
    { id: "b-unlisted", subscription_id: "s-unlisted", invoice_id: null, term_start: "2026-12-01", period_index: 1, due_on: null, period_start: "2026-12-01", period_end: "2027-01-01", taxable_amount: 10000 },
  ];
  tables.renewal_quote_subscriptions = [
    { id: 1, quote_id: "Q-TOGETHER", subscription_id: "s-tog-a", renewal_term_date: "2026-12-01", subtotal: 100000, renewed_at: null, released_at: null },
    { id: 2, quote_id: "Q-TOGETHER", subscription_id: "s-tog-b", renewal_term_date: "2026-12-01", subtotal: 100000, renewed_at: null, released_at: null },
    { id: 3, quote_id: "Q-TOGETHER-OLD", subscription_id: "s-tog-b", renewal_term_date: "2026-12-01", subtotal: 100000, renewed_at: null, released_at: "2026-09-15T05:00:00+00:00" },
    { id: 4, quote_id: "Q-UNLISTED", subscription_id: "s-unlisted", renewal_term_date: "2026-12-01", subtotal: 100000, renewed_at: null, released_at: null },
  ];
  tables.invoices = [
    invoice({ id: "INV-CREDIT", quote_id: "Q-CREDIT" }),
    invoice({ id: "INV-PART-1", quote_id: "Q-SOURCE", invoice_date: "2026-11-01", status: "paid", amount: 11800, paid_amount: 11800, created_at: "2026-11-01T05:00:00+00:00" }),
    invoice({ id: "INV-PART-0", quote_id: "Q-PARTS", status: "paid", amount: 11800, paid_amount: 11800 }),
    invoice({ id: "INV-TOG-A", quote_id: "Q-TOG-A", status: "paid", paid_amount: 118000 }),
    invoice({ id: "INV-TOGETHER", quote_id: "Q-TOGETHER", invoice_date: "2026-11-05", status: "paid", amount: 236000, paid_amount: 236000, created_at: "2026-11-05T05:00:00+00:00" }),
    invoice({ id: "INV-USD", quote_id: "Q-USD", currency: "USD", fx_rate: 83.25, amount: 50000, paid_amount: 20000, status: "partial" }),
    invoice({ id: "INV-HIDDEN", quote_id: "Q-HIDDEN", status: "paid", paid_amount: 118000 }),
    invoice({ id: "INV-HIDDEN-VOID", quote_id: "Q-HIDDEN", status: "void" }),
    invoice({ id: "INV-SEATS-VOID", quote_id: "Q-SEATS-ORIG", status: "void" }),
    invoice({ id: "INV-SEATS", quote_id: "Q-SEATS", invoice_date: "2026-06-01", amount: 23600, due_date: "2026-06-15", created_at: "2026-06-01T05:00:00+00:00" }),
    invoice({ id: "INV-UNLISTED", quote_id: "Q-UNLISTED" }),
  ];
  tables.credit_notes = [
    { id: "CN-1", invoice_id: "INV-CREDIT", amount: 59000 },
    { id: "CN-2", invoice_id: "INV-CREDIT", amount: 11800 },
    { id: "CN-UNLISTED", invoice_id: "INV-UNLISTED", amount: 118000 },
  ];
  tables.debit_notes = [{ id: "DN-1", invoice_id: "INV-CREDIT", amount: 5900 }, { id: "DN-USD", invoice_id: "INV-USD", amount: 1000 }];
  tables.payments = [
    payment({ id: "P-CREDIT", quote_id: "Q-CREDIT", amount: 47200, receipt_voucher_no: "RV-0007", reference: "UTR1" }),
    payment({ id: "P-PART-1", quote_id: "QP-1", amount: 11800, received_at: "2026-11-02T05:00:00+00:00" }),
    payment({ id: "P-PART-0", invoice_id: "INV-PART-0", amount: 11800 }),
    payment({ id: "P-TOGETHER", quote_id: "Q-TOGETHER", amount: 236000, received_at: "2026-11-06T05:00:00+00:00" }),
    payment({ id: "P-TOG-A", quote_id: "Q-TOG-A" }),
    payment({ id: "P-USD", quote_id: "Q-USD", amount: 20000 }),
    payment({ id: "P-HIDDEN", quote_id: "Q-HIDDEN", received_at: "2025-12-07T05:00:00+00:00" }),
    payment({ id: "P-HIDDEN-INV", invoice_id: "INV-HIDDEN", amount: 500, received_at: "2025-12-09T05:00:00+00:00" }),
    payment({ id: "P-HIDDEN-VOID", invoice_id: "INV-HIDDEN-VOID", amount: 77 }),
    payment({ id: "P-REFUND", quote_id: "Q-SEATS", status: "refunded", refunded_at: "2026-06-10T05:00:00+00:00", amount: 23600 }),
    payment({ id: "P-SEATS", quote_id: "Q-SEATS", amount: 10000, received_at: "2026-06-12T05:00:00+00:00" }),
    payment({ id: "P-UNLISTED", quote_id: "Q-UNLISTED" }),
  ];
});

const oldWay = async () => {
  const docRows = await readRenewalDocRows(SUBS, { concurrency: RENEWALS_READ_CONCURRENCY });
  const [docs, paid] = await Promise.all([
    docsFromRows(SUBS, docRows, { concurrency: RENEWALS_READ_CONCURRENCY }),
    lastPaidFromDocRows(SUBS, docRows, { concurrency: RENEWALS_READ_CONCURRENCY }),
  ]);
  return { docRows, docs, paid };
};
const newWay = async () => {
  const answer = await readRenewalRowFacts(SUBS);
  if (!answer) throw new Error("no answer");
  const client = answer.client();
  const docRows = await readRenewalDocRows(SUBS, { client });
  const docs = await docsFromRows(SUBS, docRows, { client });
  const paid = await lastPaidFromDocRows(SUBS, docRows, { client });
  return { docRows, docs, paid, misses: client.misses };
};

describe("R-2876 one read gives the SAME rows as the four trips", () => {
  it("every row: Last docs and Last paid are deep-equal, old way vs one read", async () => {
    const before = (await trips(oldWay)).value;
    tableReads = [];
    const after = (await trips(newWay)).value;
    expect(after.misses).toEqual([]);
    /* the rows the readers were given, read by read */
    expect(after.docRows).toEqual(before.docRows);
    for (const s of SUBS) {
      expect(after.docs.get(s.id), `Last docs of ${s.id}`).toEqual(before.docs.get(s.id));
      expect(after.paid.get(s.id), `Last paid of ${s.id}`).toEqual(before.paid.get(s.id));
    }
    expect([...after.docs.keys()]).toEqual([...before.docs.keys()]);
    expect([...after.paid.keys()]).toEqual([...before.paid.keys()]);
  });

  it("the fixture really holds each case (so the equality above is not empty = empty)", async () => {
    const { docs, paid, docRows } = (await trips(newWay)).value;
    /* together member: both members show the together quote and its payment */
    for (const id of ["s-tog-a", "s-tog-b"]) {
      expect(docs.get(id)!.linkedQuotes?.map((q) => q.id), id).toContain("Q-TOGETHER");
      expect(paid.get(id)!.history.map((h) => h.paymentId), id).toContain("P-TOGETHER");
    }
    expect(docRows.links.map((l) => l.quote_id)).not.toContain("Q-TOGETHER-OLD");           // the released link is left out
    /* billed in parts: the part proformas and the part invoice */
    expect(docRows.parts.map((q) => q.id)).toEqual(["QP-1", "QP-2"]);
    expect(docs.get("s-parts")!.invoices.map((i) => i.id)).toContain("INV-PART-1");
    expect(paid.get("s-parts")!.history.map((h) => h.paymentId)).toEqual(expect.arrayContaining(["P-PART-1", "P-PART-0"]));
    /* credit + debit note reach the invoice's words */
    expect(JSON.stringify(docs.get("s-credit")!.invoices.find((i) => i.id === "INV-CREDIT"))).toMatch(/70800|credit/i);
    /* foreign currency kept as stored */
    expect(JSON.stringify(docs.get("s-usd"))).toContain("USD");
    /* no documents */
    expect(docs.get("s-none")).toMatchObject({ quote: null, invoice: null, invoices: [] });
    expect(paid.get("s-none")?.history ?? []).toEqual([]);
    /* a quote this login may not read still brings its payments; the void invoice's payment and the refund do not count */
    expect(paid.get("s-hidden")!.history.map((h) => h.paymentId)).toEqual(["P-HIDDEN-INV", "P-HIDDEN"]);
    expect(paid.get("s-seats")!.history.map((h) => h.paymentId)).toEqual(["P-SEATS"]);
    /* nothing of a subscription that is not listed */
    expect(JSON.stringify([...docs.values(), ...paid.values()])).not.toContain("UNLISTED");
  });

  it("TRIPS — one read: 1 trip and no table read (the old way: 4 or more trips, a dozen table reads)", async () => {
    const before = await trips(oldWay);
    const oldReads = tableReads.length;
    expect(before.trips).toBeGreaterThanOrEqual(4);
    expect(oldReads).toBeGreaterThanOrEqual(10);
    tableReads = [];
    const after = await trips(newWay);
    expect(after.trips).toBe(1);
    expect(rpcCalls).toBe(1);
    expect(tableReads).toEqual([]);
  });

  it("the page's two readers started together share ONE request", async () => {
    const run = () => Promise.all([
      withRowFacts(SUBS, async (client) => docsFromRows(SUBS, await readRenewalDocRows(SUBS, { client }), { client }), async () => { throw new Error("old way used"); }),
      withRowFacts(SUBS, async (client) => lastPaidFromDocRows(SUBS, await readRenewalDocRows(SUBS, { client }), { client }), async () => { throw new Error("old way used"); }),
    ]);
    const { value, trips: n } = await trips(run);
    expect(n).toBe(1);
    expect(rpcCalls).toBe(1);
    expect(tableReads).toEqual([]);
    expect(value[0].size).toBe(SUBS.length);
  });
});

describe("R-2876 at staging size — 786 subscriptions (the count R-2855 / R-2861 measured)", () => {
  const N = 786;
  const id = (p: string, i: number) => `${p}${String(i).padStart(4, "0")}`;
  const BIG = Array.from({ length: N }, (_, i) => sub(id("s", i), { quote_id: id("Q", i), renewal_quote_id: id("R", i) }));
  beforeEach(() => {
    tables.subscriptions = BIG.map((s) => ({ id: s.id, quote_id: s.quote_id }));
    tables.quotes = BIG.flatMap((s, i) => [
      quote({ id: s.quote_id!, status: "accepted", payment_status: "invoiced", created_at: "2025-11-01T05:00:00+00:00", created_date: "2025-11-01", invoice_id: id("I", i) }),
      quote({ id: s.renewal_quote_id!, renewal_subscription_id: s.id, is_renewal: true, renewal_term_date: "2026-12-01" }),
    ]);
    tables.subscription_billings = []; tables.renewal_quote_subscriptions = [];
    tables.invoices = BIG.map((s, i) => invoice({ id: id("I", i), quote_id: s.quote_id, status: i % 3 ? "paid" : "pending", paid_amount: i % 3 ? 118000 : 0 }));
    tables.credit_notes = BIG.filter((_, i) => i % 50 === 0).map((_, i) => ({ id: id("CN", i), invoice_id: id("I", i * 50), amount: 1180 }));
    tables.debit_notes = [];
    tables.payments = BIG.filter((_, i) => i % 3).map((s, i) => payment({ id: id("P", i), quote_id: s.quote_id }));
  });

  it("Status / Last bill / Last paid: 1 trip (the old reads: 6 for Status alone — R-2855's 4 + 2 — then Last paid's)", async () => {
    const run = (way: "old" | "new") => async () => {
      const client = way === "new" ? (await readRenewalRowFacts(BIG))!.client() : undefined;
      const c = client ? { client } : { concurrency: RENEWALS_READ_CONCURRENCY };
      const docRows = await readRenewalDocRows(BIG, c);
      const docs = await docsFromRows(BIG, docRows, c);
      const paid = await lastPaidFromDocRows(BIG, docRows, c);
      return { docs, paid, misses: client?.misses ?? [] };
    };
    const before = await trips(run("old"));
    expect(before.trips).toBeGreaterThanOrEqual(6);
    tableReads = [];
    const after = await trips(run("new"));
    expect(after.trips).toBe(1);
    expect(tableReads).toEqual([]);
    expect(after.value.misses).toEqual([]);
    /* the same rows for all 786, in the same order (the stand-in pages and chunks exactly as the reads do) */
    expect(after.value.docs).toEqual(before.value.docs);
    expect(after.value.paid).toEqual(before.value.paid);
    expect(after.value.docs.size).toBe(N);
  });
});

describe("R-2876 fallback — the page still works the old way", () => {
  const viaPage = () => withRowFacts(SUBS,
    async (client) => docsFromRows(SUBS, await readRenewalDocRows(SUBS, { client }), { client }),
    async () => docsFromRows(SUBS, await readRenewalDocRows(SUBS, { concurrency: RENEWALS_READ_CONCURRENCY }), { concurrency: RENEWALS_READ_CONCURRENCY }));

  it("the function is missing (app deployed before the DB step): old reads, same rows; not asked for again", async () => {
    const want = (await trips(oldWay)).value.docs;
    rpcMode = "missing"; tableReads = [];
    const got = (await trips(viaPage)).value;
    expect(got).toEqual(want);
    expect(tableReads.length).toBeGreaterThan(0);
    expect(rpcCalls).toBe(1);
    await trips(viaPage);
    expect(rpcCalls).toBe(1);   // remembered for this page load
  });

  it("an answer that lacks a column the page selects is thrown away — old reads, same rows (never half an answer)", async () => {
    const want = (await trips(oldWay)).value.docs;
    rpcMode = "thin"; tableReads = [];
    const got = (await trips(viaPage)).value;
    expect(got).toEqual(want);
    expect(tableReads).toContain("invoices");
    /* an answer that does not fit is not asked for again on every refresh (it would cost a trip each time) */
    await trips(viaPage);
    expect(rpcCalls).toBe(1);
  });

  it("a read that FAILS (a timeout, a refusal) is not tried again for 5 minutes — a slow failure is never paid on every refresh", async () => {
    rpcMode = "error";
    let clock = 1_000_000;
    const now = () => clock;
    expect((await trips(() => readRenewalRowFacts(SUBS, now))).value).toBeNull();
    expect(rpcCalls).toBe(1);
    rpcMode = "ok";
    clock += ROW_FACTS_RETRY_MS - 1;
    expect((await trips(() => readRenewalRowFacts(SUBS, now))).value).toBeNull();
    expect(rpcCalls).toBe(1);
    clock += 2;
    expect((await trips(() => readRenewalRowFacts(SUBS, now))).value).not.toBeNull();
    expect(rpcCalls).toBe(2);
  });

  it("nothing listed → no read at all", async () => {
    expect(await readRenewalRowFacts([])).toBeNull();
    expect(rpcCalls).toBe(0);
  });

  it("a reader that starts LATER (after a payment / quote change) never joins a read that began before it", async () => {
    let clock = 5_000;
    const now = () => clock;
    const first = fetchRenewalRowFacts(SUBS, now);
    const together = fetchRenewalRowFacts(SUBS, now);              // Last docs + Last paid, same moment
    expect(together).toBe(first);
    clock += ROW_FACTS_JOIN_MS + 1;                                 // …a payment is saved, the reader is invalidated
    const later = fetchRenewalRowFacts(SUBS, now);
    expect(later).not.toBe(first);
    await trips(() => Promise.all([first, later]));
    expect(rpcCalls).toBe(2);
  });
});

describe("R-2876 the stand-in answers only what the function covered", () => {
  const ASKED = SUBS.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((x): x is string => !!x);   // as the page asks
  const facts = (): RenewalRowFacts => rowFacts(SUBS.map((s) => s.id), ASKED) as unknown as RenewalRowFacts;
  const read = async (c: ReturnType<typeof factsClient>, table: string, col: string, ids: string[], select = "id") =>
    c.from(table).select(select).in(col, ids).order("id", { ascending: true }).range(0, 999);

  it("an id the function was not asked about → refused, recorded", async () => {
    const c = factsClient(facts(), SUBS.map((s) => s.id), ASKED);
    expect((await read(c, "quotes", "renewal_subscription_id", ["s-unlisted"])).error).toBeTruthy();
    expect((await read(c, "invoices", "quote_id", ["Q-SOURCE"])).error).toBeTruthy();   // a main = false quote: its invoices were not looked up
    expect((await read(c, "payments", "invoice_id", ["INV-UNLISTED"])).error).toBeTruthy();
    expect(c.misses).toHaveLength(3);
  });
  it("payments only with status = received; unknown table / column / order / select → refused", async () => {
    const c = factsClient(facts(), SUBS.map((s) => s.id), ASKED);
    expect((await read(c, "payments", "quote_id", ["Q-CREDIT"])).error).toBeTruthy();
    expect((await c.from("payments").select("id").in("quote_id", ["Q-CREDIT"]).eq("status", "received").order("id").range(0, 9)).data).toEqual([{ id: "P-CREDIT" }]);
    expect((await read(c, "quote_send_log", "quote_id", ["Q-CREDIT"])).error).toBeTruthy();
    expect((await read(c, "quotes", "customer_id", ["x"])).error).toBeTruthy();
    expect((await read(c, "quotes", "id", ["Q-CREDIT"], "id, customer_name")).error).toBeTruthy();
    expect((await read(c, "quotes", "id", ["Q-CREDIT"], "*")).error).toBeTruthy();
    expect((await c.from("quotes").select("id").in("id", ["Q-CREDIT"]).order("created_at").range(0, 9)).error).toBeTruthy();
    expect((await c.from("quotes").select("id").in("id", ["Q-CREDIT"]).range(0, 9)).error).toBeTruthy();
  });
  it("a filter on a column the function does not return, or a query method the stand-in does not have → refused (never an empty 'answer')", async () => {
    const c = factsClient(facts(), SUBS.map((s) => s.id), ASKED);
    expect((await c.from("payments").select("id").in("quote_id", ["Q-CREDIT"]).eq("status", "received").eq("tenant_id", "t").order("id").range(0, 9)).error).toBeTruthy();
    expect((await c.from("invoices").select("id").in("quote_id", ["Q-CREDIT"]).neq("document_kind", "opening_invoice").order("id").range(0, 9)).error).toBeTruthy();
    /* .is() / .or() / .gte() … are not on the stand-in: the chain still ends in a refusal and a recorded miss,
       so a reader that swallows its own errors (together links, round 3) cannot hide it */
    const loose = c.from("renewal_quote_subscriptions") as unknown as { select(s: string): { in(c: string, i: string[]): { is(c: string, v: null): { order(c: string): { range(a: number, b: number): Promise<{ data: unknown; error: unknown }> } } } } };
    expect((await loose.select("quote_id").in("subscription_id", ["s-tog-a"]).is("released_at", null).order("id").range(0, 9)).error).toBeTruthy();
    expect(c.misses).toHaveLength(3);
    expect(c.misses[2]).toContain(".is() is not covered");
  });
  it("paging and neq work as PostgREST's", async () => {
    const c = factsClient(facts(), SUBS.map((s) => s.id), ASKED);
    const all = (await read(c, "quotes", "id", ["Q-CREDIT", "QR-CREDIT", "Q-USD"])).data!;
    expect(all.map((r) => r.id)).toEqual(["Q-CREDIT", "Q-USD", "QR-CREDIT"]);
    expect((await c.from("quotes").select("id").in("id", ["Q-CREDIT", "QR-CREDIT", "Q-USD"]).order("id").range(1, 1)).data).toEqual([{ id: "Q-USD" }]);
    const notVoid = await c.from("invoices").select("id, status").in("quote_id", ["Q-SEATS-ORIG", "Q-SEATS"]).neq("status", "void").order("id").range(0, 9);
    expect(notVoid.data).toEqual([{ id: "INV-SEATS", status: "pending" }]);
    expect(c.misses).toEqual([]);
  });
  it("parseSelect: columns and one embed; nothing clever", () => {
    expect(parseSelect("a, b, quotes(c, d)")).toEqual([{ col: "a" }, { col: "b" }, { embed: "quotes", cols: ["c", "d"] }]);
    expect(parseSelect("*")).toBeNull();
    expect(parseSelect("a::text")).toBeNull();
    expect(parseSelect("x:a")).toBeNull();
  });
});

describe("R-2876 wiring + the function's contract", () => {
  const src = (f: string) => readFileSync(`src/app/(app)/renewals/${f}`, "utf8");
  const migration = readFileSync("supabase/migrations/20261116215511_r2876_renewal_row_facts.sql", "utf8");

  it("both page hooks go through the one read, with the old reads as the fallback", () => {
    for (const f of ["last-docs-data.ts", "last-paid-data.ts"]) {
      const hook = src(f).split("export function useRenewalLast")[1].split("\nexport ")[0];
      expect(hook, f).toMatch(/withRowFacts\(rows,/);
      expect(hook, f).toMatch(/fetchRenewalDocRows\(qc, rows\)/);
    }
    expect(typeof useRenewalLastDocs).toBe("function");
  });

  it("the function is read-only, SECURITY INVOKER, granted to authenticated only", () => {
    expect(migration).toMatch(/\nstable\nsecurity invoker\nset search_path = public\n/);
    expect(migration).not.toMatch(/security definer/i);
    expect(migration).not.toMatch(/\b(insert into|update |delete from)\b/i);
    expect(migration).toMatch(/revoke all on function public\.renewal_row_facts\(uuid\[\], text\[\]\) from public;/);
    expect(migration).toMatch(/revoke all on function public\.renewal_row_facts\(uuid\[\], text\[\]\) from anon;/);
    expect(migration).toMatch(/grant execute on function public\.renewal_row_facts\(uuid\[\], text\[\]\) to authenticated;/);
    /* rows, not totals */
    expect(migration).not.toMatch(/\bsum\(/i);
  });

  it("every column the page's reads select is returned by the function (a new column must be added there too — else the page silently reads the slow old way)", () => {
    const body = migration.split("as $$")[1].split("$$;")[0];
    const cols = (file: string, name: string) => {
      const m = new RegExp(`const ${name} = [\`"]([^\`"]+)[\`"]`).exec(src(file));
      if (!m) throw new Error(`${name} not found in ${file}`);
      return m[1].replace("${QUOTE_COLS}, ", "").split(",").map((c) => c.trim());
    };
    const wanted: [string, string[]][] = [
      ["q", [...cols("last-docs-data.ts", "QUOTE_COLS"), ...cols("last-docs-data.ts", "PART_COLS"), ...cols("last-docs-data.ts", "DETAIL_COLS")]],
      ["i", cols("last-docs-data.ts", "INVOICE_COLS")],
      ["p", cols("last-paid-data.ts", "PAYMENT_COLS")],
      ["l", cols("together-links-data.ts", "TOGETHER_LINK_COLS")],
      ["b", "id, subscription_id, invoice_id, term_start, period_index, due_on, period_start, period_end, taxable_amount".split(", ")],
    ];
    for (const [alias, list] of wanted) for (const c of list) expect(body, `${alias}.${c}`).toContain(`${alias}.${c}`);
    /* the billing columns above are the ones the page asks for */
    expect(src("last-docs-data.ts")).toContain('.select("id, subscription_id, invoice_id, term_start, period_index, due_on, period_start, period_end, taxable_amount")');
  });
});
