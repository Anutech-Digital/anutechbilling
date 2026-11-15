/**
 * R-2849 (R-2809c) — Bill together for YEARLY subscriptions: the pure half. ONE renewal quote with a line per
 * subscription's next term (own plan, seats, rate, period), GST on the total, paise totals; plain refusals (other
 * customer, mixed with parts, open quote, already renewed, not one year, not priced, mixed GST, not ready); the retry
 * answer; suggestions group yearly rows of one customer (same last bill, or same domain + renewal month) and never
 * mix them with parts.
 */
import { describe, it, expect } from "vitest";
import { buildTogetherPreview, existingTogetherRenewal, periodsChanged, togetherKind, type TogetherFact } from "./bill-together-preview";
import { suggestBillTogether, canOfferBillTogether, type BillTogetherRow } from "./bill-together";
import { renewalLinePeriod, renewalLineOf, renewalRpcRefusal, RENEWAL_TOGETHER_NOT_READY } from "./bill-together-renewal.server";

const STD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TODAY = "2026-10-20";

type Over = Partial<NonNullable<TogetherFact["sub"]>> & { line?: Partial<NonNullable<NonNullable<TogetherFact["renewal"]>["line"]>> | null;
  renewal?: Partial<NonNullable<TogetherFact["renewal"]>> };

/* ITBUZZ: Business Standard 20 seats × ₹1,080 (renews 31 Oct) + Business Starter 10 seats × ₹1,632.50 (renews 15 Nov). */
function yearly(id: string, o: Over = {}): TogetherFact {
  const std = id === STD;
  const rd = o.renewal_date === undefined ? (std ? "2026-10-31" : "2026-11-15") : o.renewal_date;
  const seats = std ? 20 : 10;
  const rate = std ? 1080 : 1632.5;
  const line = o.line === null ? null : {
    seats, seatRate: rate, periodStart: rd ?? "", periodEnd: std ? "2027-10-30" : "2027-11-14",
    taxable: seats * rate, taxRate: 18, tax: Math.round(seats * rate * 0.18), gross: seats * rate + Math.round(seats * rate * 0.18), ...(o.line ?? {}),
  };
  const { line: _l, renewal, ...subOver } = o;
  void _l;
  return {
    id,
    sub: { id, customer_id: "cust-1", customer_name: "ITBUZZ Technologies", plan: std ? "Business Standard" : "Business Starter",
      billing_cycle: "yearly", status: "active", auto_renew: true, renewal_quote_id: null, renewal_date: rd, term_months: 12, ...subOver },
    next: null, togetherBills: [],
    renewal: { line, priceError: null, settled: null, linked: null, ...(renewal ?? {}) },
  };
}

const reasonsOf = (p: ReturnType<typeof buildTogetherPreview>, id: string) => p.subs.find((s) => s.subscriptionId === id)!.reasons;

describe("R-2849 yearly preview", () => {
  it("R-2849 yearly A: two yearly subs → kind renewal, a line each with its own seats / rate / period, GST on the TOTAL, paise", () => {
    const p = buildTogetherPreview([yearly(STD), yearly(STA)], TODAY);
    expect(p.kind).toBe("renewal");
    expect(p.subs.map((s) => s.reasons)).toEqual([[], []]);
    expect(p.subs[0].line).toMatchObject({ seats: 20, seatRate: 1080, periodStart: "2026-10-31", periodEnd: "2027-10-30", taxable: 21600 });
    expect(p.subs[1].line).toMatchObject({ seats: 10, seatRate: 1632.5, periodStart: "2026-11-15", periodEnd: "2027-11-14", taxable: 16325 });
    /* GST once on ₹37,925 = ₹6,826.50 → ₹6,827 (the RPC's round(subtotal × rate)), not the sum of line roundings */
    expect(p.total).toEqual({ taxable: 37925, tax: 6827, gross: 44752 });
  });

  it("R-2849 yearly paise: line taxables with paise add up as paise (no float tail)", () => {
    const p = buildTogetherPreview([yearly(STD, { line: { taxable: 0.1 } }), yearly(STA, { line: { taxable: 0.2 } })], TODAY);
    expect(p.total.taxable).toBe(0.3);
  });

  it("togetherKind: the first found subscription decides; parts when it is billed in parts", () => {
    expect(togetherKind([yearly(STD), yearly(STA)])).toBe("renewal");
    expect(togetherKind([yearly(STD, { billing_cycle: "monthly" }), yearly(STA)])).toBe("parts");
    expect(togetherKind([{ id: "x", sub: null, next: null, togetherBills: [] }, yearly(STA)])).toBe("renewal");
  });

  it("R-2849 yearly other customer: refused, plain words", () => {
    const p = buildTogetherPreview([yearly(STD), yearly(STA, { customer_id: "cust-2", customer_name: "Other Co" })], TODAY);
    expect(reasonsOf(p, STA)).toEqual([{ code: "other_customer", text: "It is Other Co's, not ITBUZZ Technologies's — one bill is for one customer." }]);
    expect(p.subs[1].line).toBeNull();
    expect(p.total.taxable).toBe(21600);
  });

  it("R-2849 mixed: a split sub ticked with yearly ones → mixed_billing; a yearly one ticked with split ones → yearly", () => {
    const p = buildTogetherPreview([yearly(STD), yearly(STA, { billing_cycle: "monthly" })], TODAY);
    expect(reasonsOf(p, STA)[0].code).toBe("mixed_billing");
    expect(reasonsOf(p, STA)[0].text).toMatch(/parts and yearly renewals cannot be on one bill/);
    const q = buildTogetherPreview([yearly(STD, { billing_cycle: "monthly" }), yearly(STA)], TODAY);
    expect(q.kind).toBe("parts");
    expect(reasonsOf(q, STA)[0]).toMatchObject({ code: "yearly" });
    expect(reasonsOf(q, STA)[0].text).toMatch(/Tick only yearly subscriptions/);
  });

  it("R-2849 not billable: not active / Won't renew / no renewal date / not a one-year term", () => {
    const at = (o: Over) => reasonsOf(buildTogetherPreview([yearly(STD), yearly(STA, o)], TODAY), STA)[0];
    expect(at({ status: "cancelled" })).toEqual({ code: "not_billable", text: "It is cancelled — only an active subscription can be renewed." });
    expect(at({ auto_renew: false }).text).toMatch(/Won't renew/);
    expect(at({ renewal_date: null }).text).toBe("It has no renewal date — set it on the subscription first.");
    expect(at({ term_months: 24 }).text).toMatch(/^It renews for 24 months — only one-year renewals/);
    expect(at({ billing_cycle: null }).text).toMatch(/only one-year renewals/);
  });

  it("R-2849 open quote: a single renewal quote still open → open_renewal_quote naming it; a closed (dead) link is no reason", () => {
    const open = buildTogetherPreview([yearly(STD), yearly(STA, { renewal_quote_id: "Q-7", renewal: { linked: { quoteId: "Q-7", live: true, subscriptionIds: [], withPlans: [] } } })], TODAY);
    expect(reasonsOf(open, STA)).toEqual([{ code: "open_renewal_quote", text: "Renewal quote Q-7 is still open (or has money received on it) for it — cancel it, or record the rest of the payment on it, first; then renew together." }]);
    const dead = buildTogetherPreview([yearly(STD), yearly(STA, { renewal_quote_id: "Q-7", renewal: { linked: { quoteId: "Q-7", live: false, subscriptionIds: [], withPlans: [] } } })], TODAY);
    expect(reasonsOf(dead, STA)).toEqual([]);
  });

  it("R-2849 open quote: already on a live together quote with another sub → already_together + onTogetherBill", () => {
    const linked = { quoteId: "Q-9", live: true, subscriptionIds: [STA, OTH], withPlans: ["Vault"] };
    const p = buildTogetherPreview([yearly(STD), yearly(STA, { renewal_quote_id: "Q-9", renewal: { linked } })], TODAY);
    expect(reasonsOf(p, STA)).toEqual([{ code: "already_together", text: "Its renewal is already on renewal quote Q-9 with Vault — open that quote (cancel it to make a new one)." }]);
    expect(p.subs[1].onTogetherBill).toEqual({ quoteId: "Q-9", status: "open", withPlans: ["Vault"] });
  });

  it("R-2849 settled: already renewed for this term → not_billable with Generate's words", () => {
    const text = "Already renewed — the next term's renewal quote opens 30 days before 2027-11-15.";
    const p = buildTogetherPreview([yearly(STD), yearly(STA, { renewal: { settled: text, line: null } })], TODAY);
    expect(reasonsOf(p, STA)).toEqual([{ code: "not_billable", text }]);
  });

  it("R-2849 not priced: the price could not be worked out → says why, nothing to tick", () => {
    const p = buildTogetherPreview([yearly(STD), yearly(STA, { line: null, renewal: { priceError: "its scheduled seat cuts could not be read" } })], TODAY);
    expect(reasonsOf(p, STA)).toEqual([{ code: "not_billable", text: "Its renewal price could not be worked out (its scheduled seat cuts could not be read) — use Review renewal quote on its row." }]);
  });

  it("R-2849 gst: an export (0%) renewal with an 18% one → different_gst on the second", () => {
    const p = buildTogetherPreview([yearly(STD), yearly(STA, { line: { taxRate: 0, tax: 0, gross: 16325 } })], TODAY);
    expect(reasonsOf(p, STA)).toEqual([{ code: "different_gst", text: "Its GST is 0%, the others' 18% — renewals with different GST rates cannot be on one quote. Make its renewal quote on its own." }]);
  });

  it("R-2849 not ready: the server cannot make a together renewal quote yet → every yearly line says so", () => {
    const p = buildTogetherPreview([yearly(STD), yearly(STA)], TODAY, { renewalNotReady: RENEWAL_TOGETHER_NOT_READY });
    expect(p.subs.every((s) => s.reasons[0]?.text === RENEWAL_TOGETHER_NOT_READY && !s.line)).toBe(true);
  });

  it("R-2849 renewal not-started rule does not apply: a renewal next month joins one due now", () => {
    const p = buildTogetherPreview([yearly(STD, { line: { periodStart: "2026-10-01" } }), yearly(STA, { line: { periodStart: "2026-12-15" } })], TODAY);
    expect(p.subs.map((s) => s.reasons)).toEqual([[], []]);
  });
});

describe("R-2849 retry + date moved", () => {
  const linked = { quoteId: "Q-T", live: true, subscriptionIds: [STD, STA], withPlans: [] as string[] };
  const on = (id: string, plans: string[]) => yearly(id, { renewal_quote_id: "Q-T", renewal: { linked: { ...linked, withPlans: plans } } });

  it("R-2849 retry: both linked to the same live together quote holding exactly them → that quote", () => {
    expect(existingTogetherRenewal([on(STD, ["Business Starter"]), on(STA, ["Business Standard"])])).toBe("Q-T");
  });
  it("not the same set (a third asked, one not linked, dead quote) → null", () => {
    expect(existingTogetherRenewal([on(STD, []), on(STA, []), yearly(OTH)])).toBeNull();
    expect(existingTogetherRenewal([on(STD, []), yearly(STA)])).toBeNull();
    expect(existingTogetherRenewal([yearly(STD, { renewal_quote_id: "Q-T", renewal: { linked: { ...linked, live: false } } }), on(STA, [])])).toBeNull();
  });

  it("R-2849 date moved: the renewal the screen showed is not what would be made now → renewal words, nothing made", () => {
    const p = buildTogetherPreview([yearly(STD, { renewal_date: "2026-11-30" }), yearly(STA)], TODAY);
    const msg = periodsChanged(p, new Map([[STD, "2026-10-31"], [STA, "2026-11-15"]]));
    expect(msg).toBe("What will be renewed changed since you opened it — you saw Business Standard's renewal from 31 Oct 2026, now it would renew from 30 Nov 2026. Nothing was made — refresh Renewals and check again.");
    expect(periodsChanged(buildTogetherPreview([yearly(STD), yearly(STA)], TODAY), new Map([[STD, "2026-10-31"], [STA, "2026-11-15"]]))).toBeNull();
  });
});

describe("R-2849 server helpers (pure)", () => {
  it("renewalLinePeriod: app-made sub (renewal on a term boundary) starts ON the renewal date; a last-day (imported) one the day after", () => {
    expect(renewalLinePeriod({ renewal_date: "2026-10-31", start_date: "2025-10-31", term_months: 12 })).toEqual({ start: "2026-10-31", end: "2027-10-30" });
    expect(renewalLinePeriod({ renewal_date: "2026-10-31", start_date: "2025-11-01", term_months: 12 })).toEqual({ start: "2026-11-01", end: "2027-10-31" });
    expect(renewalLinePeriod({ renewal_date: null, start_date: null, term_months: 12 })).toBeNull();
  });

  it("renewalLineOf: seats × rate, the line's GST shown, gross", () => {
    const line = renewalLineOf({ ok: true, pQuote: {}, lineItems: [], seats: 10, perSeatRate: 1632.5, subtotal: 16325, amount: 19264, taxRate: 18, termMonths: 12 },
      { start: "2026-11-15", end: "2027-11-14" });
    expect(line).toEqual({ seats: 10, seatRate: 1632.5, periodStart: "2026-11-15", periodEnd: "2027-11-14", taxable: 16325, taxRate: 18, tax: 2939, gross: 19264 });
  });

  it("R-2849 rpc refusal: not ready / missing → 503 plain; seat-cut check_violation and 22023 → 409 with the RPC's words; raw DB text never shown", () => {
    expect(renewalRpcRefusal({ code: "0A000", message: "x" })).toEqual({ status: 503, error: RENEWAL_TOGETHER_NOT_READY });
    expect(renewalRpcRefusal({ code: "42883", message: "function does not exist" })).toEqual({ status: 503, error: RENEWAL_TOGETHER_NOT_READY });
    expect(renewalRpcRefusal({ code: "23514", message: "A seat cut to 15 seats is scheduled …" })).toEqual({ status: 409, error: "A seat cut to 15 seats is scheduled …" });
    expect(renewalRpcRefusal({ code: "22023", message: "Subscriptions of different customers cannot be on one renewal quote" })?.status).toBe(409);
    expect(renewalRpcRefusal({ code: "22023", message: "duplicate key value violates unique constraint" })).toBeNull();
    expect(renewalRpcRefusal({ code: "42501", message: "permission denied for table quotes" })?.error).toBe("Your login may not bill subscriptions together — ask the workspace owner.");
  });
});

describe("R-2849 suggestions + offer", () => {
  const row = (o: Partial<BillTogetherRow> = {}): BillTogetherRow => ({
    id: "a", customerId: "c-1", customerName: "ITBUZZ Technologies", plan: "Business Standard", seats: 20, domain: "itbuzz.in",
    split: false, billable: true, billingCycle: "yearly", nextPartStart: "2026-10-31", lastQuoteId: null, lastInvoiceId: null, ...o,
  });

  it("yearly rows that shared last year's invoice → one renewal group (same-bill)", () => {
    expect(suggestBillTogether([row({ id: "a", lastInvoiceId: "INV-1" }), row({ id: "b", lastInvoiceId: "INV-1", domain: "x.in", nextPartStart: "2026-12-01" })]))
      .toEqual([{ customerId: "c-1", customerName: "ITBUZZ Technologies", subIds: ["a", "b"], why: "same-bill", kind: "renewal" }]);
  });

  it("yearly rows: same domain + same renewal MONTH group; another month does not", () => {
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", nextPartStart: "2026-10-05" })])[0]).toMatchObject({ why: "same-domain", kind: "renewal" });
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", nextPartStart: "2026-11-15" })])).toEqual([]);
  });

  it("never mixes a split row with a yearly row, even on one invoice", () => {
    expect(suggestBillTogether([row({ id: "a", lastInvoiceId: "I" }), row({ id: "b", lastInvoiceId: "I", split: true, billingCycle: "monthly" })])).toEqual([]);
  });

  it("not billable yearly rows (quote open / not due soon) are not suggested", () => {
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", billable: false })])).toEqual([]);
  });

  it("canOfferBillTogether: all split or all yearly of one customer; never a mix", () => {
    expect(canOfferBillTogether([{ customerId: "c", split: false }, { customerId: "c", split: false }])).toBe(true);
    expect(canOfferBillTogether([{ customerId: "c", split: true }, { customerId: "c", split: true }])).toBe(true);
    expect(canOfferBillTogether([{ customerId: "c", split: true }, { customerId: "c", split: false }])).toBe(false);
    expect(canOfferBillTogether([{ customerId: "c", split: false }, { customerId: "d", split: false }])).toBe(false);
  });
});

describe("R-2849 H1 — domain and hosting never go on a together renewal quote", () => {
  it("a domain / hosting subscription is refused with plain words (its own Review renewal quote prices it live)", () => {
    for (const vendor of ["domain", "hosting"]) {
      const p = buildTogetherPreview([yearly(STD), yearly(STA, { vendor } as Over)], TODAY);
      expect(reasonsOf(p, STA)).toEqual([{ code: "not_billable", text: "It is a domain or hosting renewal — renew it with Review renewal quote on its row." }]);
      expect(p.subs[1].line).toBeNull();
    }
  });
});
