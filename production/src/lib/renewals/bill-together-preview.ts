/**
 * R-2807 (R-2805 "Bill together", Pratik — ITBUZZ: Business Standard + Business Starter, two "Bill next part"
 * buttons although last cycle they were on ONE bill) — the PURE half of /api/renewals/bill-together: from what
 * the server read about each ticked subscription (bill-together.server.ts), which can join the ONE proforma,
 * why the others cannot (plain sentences the screen shows as they are), each one's line and the total.
 *
 * Shapes: the R-2808 contract in ./bill-together.ts. Money rules, pinned:
 * - Amounts are what the proforma will carry. The parts are laid in ₹ and R-2810's bill_parts_together makes an
 *   INR proforma (0% GST for an export / USD customer, like Bill next part) — so `currency` is always "INR" and
 *   the screen never shows rupee numbers under a $ sign (R-2808 review, 14 Nov).
 * - total.tax = round(total taxable × the one GST rate) — the RPC's own rule (GST on the bill's taxable), so the
 *   total shown is the proforma's to the rupee, not a sum of per-line roundings.
 */
import type { BillTogetherLine, BillTogetherPreview, BillTogetherReasonCode, BillTogetherSub, TogetherBillRef } from "./bill-together";
import type { UnpaidEarlierPart } from "@/lib/billing/proforma";
import { isSplitBilled } from "@/lib/billing/instalments";

/**
 * The contract's reason codes plus "not_billable": not active / Won't renew / its next part could not be worked
 * out / a part not started yet next to a started one (R-2519b) — the text says which. The screen shows `text`
 * as it is and never switches on the code. Follow-up: fold "not_billable" into BillTogetherReasonCode in
 * ./bill-together.ts once R-2808 (which holds that file's lock) has landed.
 */
export type TogetherReasonCode = BillTogetherReasonCode | "not_billable";
export interface TogetherReason { code: TogetherReasonCode; text: string }
export type TogetherSub = Omit<BillTogetherSub, "reasons"> & { reasons: TogetherReason[] };
export type TogetherPreview = Omit<BillTogetherPreview, "subs"> & { subs: TogetherSub[] };

/** What the server read about one asked id. `sub` null = not in this company (or not an id at all). */
export interface TogetherFact {
  id: string;
  sub: {
    id: string;
    customer_id?: string | null;
    customer_name: string | null;
    plan: string | null;
    billing_cycle: string | null;
    status: string | null;
    auto_renew?: boolean | null;
    renewal_quote_id: string | null;
  } | null;
  /** Its next unbilled part (Bill next part's own preview, one period); null when it was not worked out. */
  next: (BillTogetherLine & { unpaidEarlier: UnpaidEarlierPart[] }) | null;
  /** Why `next` could not be worked out — a plain phrase (shown in the reason), never raw database text. */
  nextError?: string | null;
  /** Every live together proforma an unbilled part of it is on: that part's start, whether it is the
   *  subscription's oldest part with no tax invoice, and every subscription on the proforma. */
  togetherBills: TogetherBillOn[];
}

export interface TogetherBillOn extends TogetherBillRef {
  subscriptionIds: string[];
  partPeriodStart: string;
  earliestOpen: boolean;
}

/** The live together proforma that holds this subscription's NEXT part (the one Bill next part would bill). */
function onNextPart(f: TogetherFact): TogetherBillOn | null {
  const start = f.next?.periodStart;
  return start ? f.togetherBills.find((t) => t.partPeriodStart === start) ?? null : null;
}

const reason = (code: TogetherReasonCode, text: string): TogetherReason => ({ code, text });

function dayMonYear(iso: string): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(iso.slice(8, 10))} ${M[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

function cycleWord(cycle: string | null): string {
  return cycle === "yearly" || !cycle ? "yearly" : cycle.replace("_", "-");
}

/** The reasons that depend on this subscription alone (and the first one's customer). */
function ownReasons(f: TogetherFact, firstCustomer: { id: string | null; name: string | null } | null): TogetherReason[] {
  const s = f.sub;
  if (!s) return [reason("not_found", "This subscription was not found in your company — refresh Renewals and tick it again.")];
  const out: TogetherReason[] = [];
  if (firstCustomer && (s.customer_id ?? null) !== firstCustomer.id) {
    out.push(reason("other_customer", `It is ${s.customer_name ?? "another customer"}'s, not ${firstCustomer.name ?? "the first customer"}'s — one bill is for one customer.`));
  }
  if (!isSplitBilled(s.billing_cycle as Parameters<typeof isSplitBilled>[0])) {
    out.push(reason("yearly", `It is billed ${cycleWord(s.billing_cycle)}, not in parts — use Create quote for it.`));
    return out;
  }
  if (s.status !== "active") {
    out.push(reason("not_billable", `It is ${s.status ?? "not active"} — only an active subscription can be billed.`));
    return out;
  }
  if (s.auto_renew === false) {
    out.push(reason("not_billable", "It is marked Won't renew — press Undo Won't renew on the subscription first."));
    return out;
  }
  if (s.renewal_quote_id) {
    out.push(reason("open_renewal_quote", `Renewal quote ${s.renewal_quote_id} is still open for it — paying it would bill the new term twice. Cancel it first.`));
  }
  const on = onNextPart(f);
  if (on) {
    const withText = on.withPlans.length > 0 ? ` with ${on.withPlans.join(", ")}` : "";
    out.push(reason("already_together", `Its next part is already on proforma ${on.quoteId}${withText} — open that proforma (cancel it to bill again).`));
  }
  const unpaid = f.next?.unpaidEarlier[0];
  if (unpaid) {
    const doc = unpaid.kind === "invoice" ? "invoice" : "proforma";
    out.push(reason("unpaid_earlier_part", `Its part from ${dayMonYear(unpaid.start)} is still unpaid (${doc} ${unpaid.id}) — get it paid or cancel it first.`));
  }
  if (!f.next && out.length === 0) {
    out.push(reason("not_billable", `Its next part could not be worked out${f.nextError ? ` (${f.nextError})` : ""} — use Bill next part on its row.`));
  }
  return out;
}

/** The preview for the asked ids, in the asked order (duplicates dropped). */
export function buildTogetherPreview(facts: readonly TogetherFact[], todayISO: string): TogetherPreview {
  const firstFound = facts.find((f) => f.sub)?.sub ?? null;
  const firstCustomer = firstFound ? { id: firstFound.customer_id ?? null, name: firstFound.customer_name } : null;
  const rows = facts.map((f) => ({ f, reasons: ownReasons(f, firstCustomer) }));

  /* One GST rate on one bill — the first joinable one's rate decides (as the RPC refuses a mix). */
  const joinable = () => rows.filter((r) => r.reasons.length === 0 && r.f.next);
  const rate0 = joinable()[0]?.f.next?.taxRate;
  for (const r of joinable()) {
    if (r.f.next!.taxRate !== rate0) {
      r.reasons.push(reason("different_gst", `Its GST is ${r.f.next!.taxRate}%, the others' ${rate0}% — parts with different GST rates cannot be on one bill.`));
    }
  }
  /* R-2519b (the RPC's rule): a part not started yet is never billed with a started one. */
  const begun = joinable().find((r) => r.f.next!.periodStart <= todayISO);
  if (begun) {
    for (const r of joinable()) {
      if (r.f.next!.periodStart > todayISO) {
        r.reasons.push(reason("not_billable", `Its next part starts ${dayMonYear(r.f.next!.periodStart)} — a part that has not started cannot be billed with a started one (${begun.f.sub!.plan ?? "the other"}).`));
      }
    }
  }

  const subs: TogetherSub[] = rows.map(({ f, reasons }) => {
    const on = onNextPart(f);
    return {
      subscriptionId: f.sub?.id ?? f.id,
      plan: f.sub?.plan ?? null,
      customerId: f.sub?.customer_id ?? null,
      customerName: f.sub?.customer_name ?? null,
      line: reasons.length === 0 && f.next ? lineOf(f.next) : null,
      reasons,
      onTogetherBill: on ? { quoteId: on.quoteId, status: on.status, withPlans: on.withPlans } : null,
    };
  });
  const lines = subs.map((s) => s.line).filter((l): l is BillTogetherLine => !!l);
  const taxable = lines.reduce((a, l) => a + l.taxable, 0);
  const tax = lines.length > 0 ? Math.round((taxable * lines[0].taxRate) / 100) : 0;
  return { subs, total: { taxable, tax, gross: taxable + tax }, currency: "INR" };
}

function lineOf(n: BillTogetherLine): BillTogetherLine {
  return { seats: n.seats, seatRate: n.seatRate, periodStart: n.periodStart, periodEnd: n.periodEnd, taxable: n.taxable, taxRate: n.taxRate, tax: n.tax, gross: n.gross };
}

/**
 * Double submit / retry: each asked subscription's OLDEST part with no tax invoice is on the SAME live together
 * proforma, and that proforma holds exactly these subscriptions → that proforma (alreadyExisted), nothing laid,
 * no RPC call. (Anything later — next month while that proforma is unpaid — would be refused anyway: the lead's
 * earlier part is unpaid and the others' next part is on it.)
 */
export function existingTogetherBill(facts: readonly TogetherFact[]): string | null {
  if (facts.length === 0 || facts.some((f) => !f.sub)) return null;
  const firstOf = (f: TogetherFact) => f.togetherBills.find((t) => t.earliestOpen) ?? null;
  const t = firstOf(facts[0]);
  if (!t || facts.some((f) => firstOf(f)?.quoteId !== t.quoteId)) return null;
  const asked = new Set(facts.map((f) => f.sub!.id));
  const on = new Set(t.subscriptionIds);
  return asked.size === on.size && [...asked].every((id) => on.has(id)) ? t.quoteId : null;
}

/** The asked ids: trimmed, empties and repeats dropped, order kept. */
export function parseTogetherIds(raw: unknown): string[] {
  const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const x of list) {
    const id = typeof x === "string" ? x.trim() : "";
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Most subscriptions on one together bill (a Renewals screen's worth). */
export const MAX_TOGETHER_IDS = 25;
