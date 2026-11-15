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
import type { BillTogetherLine, BillTogetherPreview, BillTogetherReason, BillTogetherReasonCode, BillTogetherSub, TogetherBillRef } from "./bill-together";
import type { UnpaidEarlierPart } from "@/lib/billing/proforma";
import { isSplitBilled } from "@/lib/billing/instalments";

/*
 * Reasons use the contract's ONE code list (BillTogetherReasonCode, ./bill-together.ts — R-2845): "not_billable"
 * (not active / Won't renew / next part not worked out / a part not started next to a started one, R-2519b — the
 * text says which) and R-2831's sale-quote refusals (first_part_of_sale, sale_sibling) are in it. The screen shows
 * `text` as it is and never switches on the code.
 */

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
  /** R-2831: what the RPC's sale-quote refusals need (the sub was sold on sale quote `quoteId`); absent = none. */
  sale?: TogetherSaleFacts | null;
}

/** R-2831 — the facts behind bill_parts_together's two sale-quote refusals, so the preview shows them first. */
export interface TogetherSaleFacts {
  quoteId: string;
  /** The subscription's start date (YYYY-MM-DD) and term length — where its terms begin. */
  startDate: string | null;
  termMonths: number;
  /** Its earliest laid term's start; null = no part laid yet. */
  firstTermStart: string | null;
  /** Its next part as laid (null = not laid yet): index in its term, the term's start, credit-noted. */
  atNext: { periodIndex: number | null; termStart: string | null; credited: boolean } | null;
  /** Every other subscription of the same sale quote: its unbilled parts' starts (R-2092 group); `counted` = the
   *  RPC's "not laid yet" rule counts it (active, same cycle, not yearly, started, MRR > 0) and `laidAny` = a part. */
  siblings: Array<{ id: string; plan: string | null; counted: boolean; billedExternallyUntil: string | null; laidAny: boolean; openPeriodStarts: string[] }>;
}

/** Does a part starting `start` open a term of a subscription that began `startDate` with `termMonths`-month terms? */
function opensTerm(startDate: string, termMonths: number, start: string): boolean {
  if (start < startDate || start.slice(8, 10) !== startDate.slice(8, 10)) return false;
  const months = (Number(start.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + Number(start.slice(5, 7)) - Number(startDate.slice(5, 7));
  return months % Math.max(1, termMonths) === 0;
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

const reason = (code: BillTogetherReasonCode, text: string): BillTogetherReason => ({ code, text });

function dayMonYear(iso: string): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(iso.slice(8, 10))} ${M[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

function cycleWord(cycle: string | null): string {
  return cycle === "yearly" || !cycle ? "yearly" : cycle.replace("_", "-");
}

/** The reasons that depend on this subscription alone (and the first one's customer). */
function ownReasons(f: TogetherFact, firstCustomer: { id: string | null; name: string | null } | null, asked: ReadonlyMap<string, string | null>): BillTogetherReason[] {
  const s = f.sub;
  if (!s) return [reason("not_found", "This subscription was not found in your company — refresh Renewals and tick it again.")];
  const out: BillTogetherReason[] = [];
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
  out.push(...saleReasons(f, asked));
  if (!f.next && out.length === 0) {
    out.push(reason("not_billable", `Its next part could not be worked out${f.nextError ? ` (${f.nextError})` : ""} — use Bill next part on its row.`));
  }
  return out;
}

/**
 * R-2831 — bill_parts_together's sale-quote refusals, before anything is laid (the RPC still decides):
 * - the first part of a sale (period 1 of its earliest term, never credit-noted; not laid yet = no part at all and
 *   the part opens a term) is billed by its sale quote, with the one-time lines;
 * - R-2092: a counted sibling of the same sale quote with no parts laid yet blocks it; a sibling's unbilled part of
 *   the same period must be on the same bill (one sale quote, one period = one bill).
 * `asked` = each ticked subscription → the start of the part it would bill.
 */
function saleReasons(f: TogetherFact, asked: ReadonlyMap<string, string | null>): BillTogetherReason[] {
  const sale = f.sale;
  const start = f.next?.periodStart;
  if (!sale || !start) return [];
  const out: BillTogetherReason[] = [];
  const own = sale.atNext;
  const first = own
    ? own.periodIndex === 1 && !own.credited && !!own.termStart && own.termStart === sale.firstTermStart
    /* not laid: laying it makes it the only (so earliest) term's part — period 1 when it opens a term */
    : sale.firstTermStart === null && !!sale.startDate && opensTerm(sale.startDate, sale.termMonths, start);
  if (first) {
    out.push(reason("first_part_of_sale", `Its first part is billed by its sale quote ${sale.quoteId} — bill it from there; later parts can be billed together.`));
  }
  const others = sale.siblings.filter((s) => s.id !== f.sub?.id);
  const notLaid = others.filter((s) => s.counted && !asked.has(s.id) && !s.laidAny && (!s.billedExternallyUntil || s.billedExternallyUntil < start));
  if (notLaid.length > 0) {
    const plans = notLaid.map((s) => s.plan ?? "another subscription").join(", ");
    out.push(reason("sale_sibling", `It is sold with ${plans} on sale quote ${sale.quoteId}, whose parts are not laid yet — wait for the next billing run, then bill them together.`));
  }
  for (const s of others.filter((x) => x.openPeriodStarts.includes(start) && asked.get(x.id) !== start)) {
    const plan = s.plan ?? "another subscription";
    const theirs = asked.get(s.id);
    out.push(reason("sale_sibling", asked.has(s.id)
      ? `It is billed with ${plan}'s part from ${dayMonYear(start)} (same sale quote ${sale.quoteId}), but ${plan} would bill ${theirs ? `its part from ${dayMonYear(theirs)}` : "no part"} now — bill ${plan}'s earlier part first.`
      : `It is billed with ${plan} (same sale quote ${sale.quoteId}, same period) — tick ${plan} too.`));
  }
  return out;
}

/** The preview for the asked ids, in the asked order (duplicates dropped). */
export function buildTogetherPreview(facts: readonly TogetherFact[], todayISO: string): BillTogetherPreview {
  const firstFound = facts.find((f) => f.sub)?.sub ?? null;
  const firstCustomer = firstFound ? { id: firstFound.customer_id ?? null, name: firstFound.customer_name } : null;
  const asked = new Map(facts.filter((f) => f.sub).map((f) => [f.sub!.id, f.next?.periodStart ?? null] as const));
  const rows = facts.map((f) => ({ f, reasons: ownReasons(f, firstCustomer, asked) }));

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

  const subs: BillTogetherSub[] = rows.map(({ f, reasons }) => {
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

/**
 * The asked ids: trimmed, lowercased, empties and repeats dropped, order kept. Lowercase (R-2845, rev-r2831 L1):
 * Postgres prints uuids lowercase, so every id the server reads back (and keys the period guard by) is lowercase —
 * an UPPERCASE id kept as sent would match nothing in parseTogetherPeriods / findInvoicedTogether.
 */
export function parseTogetherIds(raw: unknown): string[] {
  const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const x of list) {
    const id = typeof x === "string" ? x.trim().toLowerCase() : "";
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * R-2831 — the part each ticked subscription bills, as the screen showed it: `[{ subscriptionId, periodStart }]`.
 * Absent → null (an older screen). Anything else malformed, a date that is not YYYY-MM-DD, an id not asked, or an
 * asked id missing → "bad". Ids are lowercased like parseTogetherIds (R-2845) — `ids` are its output.
 */
export function parseTogetherPeriods(raw: unknown, ids: readonly string[]): Map<string, string> | null | "bad" {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return "bad";
  const out = new Map<string, string>();
  for (const x of raw as Array<{ subscriptionId?: unknown; periodStart?: unknown }>) {
    const id = typeof x?.subscriptionId === "string" ? x.subscriptionId.trim().toLowerCase() : "";
    const start = typeof x?.periodStart === "string" ? x.periodStart : "";
    if (!ids.includes(id) || !realDate(start) || out.has(id)) return "bad";
    out.set(id, start);
  }
  return ids.every((id) => out.has(id)) ? out : "bad";
}

/** YYYY-MM-DD and a real calendar day — 2026-02-30 would reach Postgres and fail as a 500, not a 400 (R-2845). */
function realDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** R-2831 — the sentence when a subscription would now bill another part than the screen showed; null = same. */
export function periodsChanged(preview: BillTogetherPreview, periods: ReadonlyMap<string, string>): string | null {
  for (const s of preview.subs) {
    const shown = periods.get(s.subscriptionId);
    const now = s.line?.periodStart ?? null;
    if (shown && now !== shown) {
      return `What will be billed changed since you opened it — you saw ${s.plan ?? "a subscription"}'s part from ${dayMonYear(shown)}, `
        + `${now ? `now it would bill the part from ${dayMonYear(now)}` : "now it cannot be billed"}. Nothing was billed — refresh Renewals and check again.`;
    }
  }
  return null;
}

/** Most subscriptions on one together bill (a Renewals screen's worth). */
export const MAX_TOGETHER_IDS = 25;
