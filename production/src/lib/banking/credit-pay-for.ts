/**
 * R-1838 — "This money is for:" on a money-in bank line.
 *
 * Pardeep (staging, 24 Oct): Reconcile → Create invoice asked only a product and a total — not
 * the seats, not the unit price, and not WHICH quote the money paid. A renewal payment, an
 * add-seats (pro-rata) payment and a new product's payment all became a one-off invoice beside
 * the subscription they were for.
 *
 * Now the operator says what the money is for, and the server path does the money work
 * (migration 20261024131600: record_desk_payment → generate_invoice → reconcile_bank_txn in one
 * transaction). This module is the pure part of the sheet — nothing here computes an invoice, a
 * subscription or a balance; the amounts due come from the database (bank_credit_open_items).
 *
 *   guessCustomer      — the payer, from the narration (nameOverlap) or a strong invoice match
 *   kindLabel          — "Renewal", "Add seats · pro-rata", …
 *   preselectItem      — the open item whose due equals the credit (or the credit + TDS)
 *   amountCheck        — exact / short (TDS? part payment) / over (extra → customer credit)
 *   saleLineFromItem   — a catalogue product → seats + unit price for the new-sale editor
 *   resultLines        — what happened, in the owner's words, after the save
 */
import { customerNameTokens, narrationNames } from "@/lib/accounting/credit-match";
import { tdsRateFor } from "@/lib/banking/invoice-credit-match";
import { billingUnitOf, defaultQtyForUnit, isPerSeat, unitYearMultiplier } from "@/lib/catalog/billing-unit";
import { headlinePrice } from "@/lib/catalog/headline-price";
import { catalogLineListRate } from "@/lib/quotes/catalog-line";
import { floorWorkspaceRow } from "@/lib/catalog/workspace-floor";
import { BILLING_CYCLE_OPTIONS, cycleScheduleLabel } from "@/lib/quotes/billing";
import { COMMIT_CHOICES, type CommitChoice } from "@/lib/quotes/line-commit-choice";
import { isSplitBilled, quoteInstalmentPlan } from "@/lib/billing/instalments";
import { addDaysISO, addMonthsClamped } from "@/lib/billing/schedule";
import { rupee, formatDate } from "@/lib/utils";
import { knownPayerCustomer, payerFromNarration, type KnownPayer } from "@/lib/banking/customer-payer";
import type { BillingCycle, Item } from "@/lib/supabase/database.types";

/* ─── Open items (rows of bank_credit_open_items) ──────────────────────────────────────── */

export type OpenItemKind = "renewal" | "add_seats" | "new" | "one_off" | "invoice" | "instalment";

export interface OpenItem {
  kind: OpenItemKind;
  quote_id: string | null;
  invoice_id: string | null;
  doc_date: string;
  /** Whole rupees still owed — from the database, never recomputed here. */
  amount_due: number;
  /** Ex-GST value — the base TDS is deducted on. */
  taxable_value: number;
  /** A new sale whose payment would file subscription(s). */
  makes_subscription: boolean;
  subscription_id: string | null;
  plan: string | null;
  seats: number | null;
  renewal_date: string | null;
  lines: ReadonlyArray<{ name?: string | null; qty?: number | null; commitment?: string | null }> | null;
}

/** The key of an open item — an invoice when it has one, else its quote. */
export function itemKey(i: Pick<OpenItem, "quote_id" | "invoice_id">): string {
  return i.invoice_id ? `inv:${i.invoice_id}` : `q:${i.quote_id ?? ""}`;
}

export function kindLabel(kind: OpenItemKind): string {
  switch (kind) {
    case "renewal":    return "Renewal";
    case "add_seats":  return "Add seats · pro-rata";
    case "new":        return "New product";
    case "one_off":    return "One-time sale";
    case "instalment": return "Instalment invoice";
    default:           return "Invoice";
  }
}

/** One line under the row: what paying it does. */
export function itemDetail(i: OpenItem): string {
  const doc = i.invoice_id ?? i.quote_id ?? "";
  const plan = i.plan ? `${i.plan}${i.seats ? ` (${i.seats} seats)` : ""}` : "";
  switch (i.kind) {
    case "renewal":
      return `${doc} · ${plan || "subscription"}${i.renewal_date ? ` · renews ${formatDate(i.renewal_date)}` : ""}`;
    case "add_seats":
      return `${doc} · adds seats to ${plan || "the subscription"}`;
    case "new": {
      const first = i.lines?.[0]?.name ?? "";
      return `${doc}${first ? ` · ${first}` : ""}${i.makes_subscription ? " · starts a subscription" : ""}`;
    }
    default:
      return `${doc}${plan ? ` · ${plan}` : ""}`;
  }
}

/* ─── Customer guess ──────────────────────────────────────────────────────────────────── */

export interface CustomerLite { id: string; name: string }

export interface CustomerGuess {
  customerId: string;
  reason: string;
  /** R-2025 (4): the guess came from a known payer of this customer (customer_payers). */
  payer?: KnownPayer;
}

/** R-2025: the learned payers and our own company name(s) (never a payer). */
export interface PayerMemory { payers: readonly KnownPayer[]; ownNames: readonly string[] }

/** R-2007: words in many company names that never tell one customer from another (on top of
 *  credit-match's NAME_NOISE: pvt, ltd, co, technologies, …). */
const GENERIC_NAME_WORDS = new Set(["india", "indian", "group", "global", "international", "industries"]);

/**
 * Who paid. Only a single, unambiguous answer:
 *   1. R-2007: the ONE customer whose name shares a DISTINCTIVE word with the narration — a word
 *      no other customer's name has. Shared words ("SCN" in "SCN Acme Website Co" and "SCN Bharat
 *      Apps") and generic ones (PVT, LTD, CO, INDIA, TECHNOLOGIES) do not count, so
 *      "SCN BHARAT APPS-KIST 1 2" → SCN Bharat Apps. Two customers with their own word each → none.
 *   2. Else the customer of a "certain" open-invoice match (name or invoice no. in the narration
 *      AND the amount fits).
 * Anything else → no guess; the operator picks. A wrong guess posts a receipt to the wrong
 * customer, which is worse than no guess.
 *
 * R-2025 (4), before both: the payer the narration names (payerFromNarration) is a KNOWN payer
 * (customer_payers) of exactly one customer → that customer, "known payer for <customer>". Known
 * for two customers → no guess at all, even if a name word fits.
 */
export function guessCustomer(
  credit: { description: string | null },
  customers: readonly CustomerLite[],
  invoiceMatches: ReadonlyArray<{ customerName: string | null; confidence: string }> = [],
  memory?: PayerMemory,
): CustomerGuess | null {
  if (memory && memory.payers.length > 0) {
    const payer = payerFromNarration(credit.description, memory.ownNames);
    const hit = knownPayerCustomer(payer?.key ?? null, memory.payers);
    if (hit?.kind === "many") return null;
    if (hit?.kind === "one") {
      const c = customers.find((x) => x.id === hit.payer.customer_id);
      if (c) return { customerId: c.id, reason: `known payer for ${c.name}`, payer: hit.payer };
    }
  }
  const words = new Set(narrationNames(credit.description));
  const named = customers.map((c) => ({ c, toks: [...new Set(customerNameTokens(c.name))].filter((t) => !GENERIC_NAME_WORDS.has(t)) }));
  const howMany = new Map<string, number>();
  for (const n of named) for (const t of n.toks) howMany.set(t, (howMany.get(t) ?? 0) + 1);
  const own = named
    .map((n) => ({ c: n.c, words: n.toks.filter((t) => words.has(t) && howMany.get(t) === 1) }))
    .filter((h) => h.words.length > 0);
  if (own.length === 1) return { customerId: own[0].c.id, reason: `the bank line says “${own[0].words.join(" ")}”` };

  const certain = invoiceMatches.filter((m) => m.confidence === "certain");
  if (certain.length === 1 && certain[0].customerName) {
    const name = certain[0].customerName.trim().toLowerCase();
    const same = customers.filter((c) => c.name.trim().toLowerCase() === name);
    if (same.length === 1) return { customerId: same[0].id, reason: "an open invoice matches this payment" };
  }
  return null;
}

/* ─── Pre-selection + amount check ────────────────────────────────────────────────────── */

/**
 * The item to tick for the operator: the ONE whose due equals the credit to the rupee, else the
 * ONE that the credit pays less a common TDS rate. Two candidates → none (the operator picks).
 */
export function preselectItem(items: readonly OpenItem[], credit: number): OpenItem | null {
  const exact = items.filter((i) => i.amount_due === credit);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const tds = items.filter((i) => tdsRateFor(credit, i.amount_due, i.taxable_value || null) !== null);
  return tds.length === 1 ? tds[0] : null;
}

export type AmountCheck =
  | { kind: "exact" }
  /** Credit is less than due. `tdsRatePct` when the gap looks like TDS on the taxable value. */
  | { kind: "short"; shortBy: number; tdsRatePct: number | null }
  /** Credit is more than due — record_payment keeps the extra as customer credit. */
  | { kind: "over"; overBy: number };

export function amountCheck(credit: number, due: number, taxable: number | null): AmountCheck {
  if (credit === due) return { kind: "exact" };
  if (credit > due) return { kind: "over", overBy: credit - due };
  return { kind: "short", shortBy: due - credit, tdsRatePct: tdsRateFor(credit, due, taxable && taxable > 0 ? taxable : null) };
}

/** What the operator decided about a short payment. */
export type ShortChoice = "tds" | "part";

/** The TDS amount to send: the whole shortfall when the operator says it was TDS, else 0. */
export function tdsToRecord(check: AmountCheck, choice: ShortChoice): number {
  return check.kind === "short" && choice === "tds" ? check.shortBy : 0;
}

/** The TDS rate % to store with it — the rate that explains the gap, else the gap ÷ taxable. */
export function tdsRateToRecord(check: AmountCheck, taxable: number): number | null {
  if (check.kind !== "short") return null;
  if (check.tdsRatePct !== null) return check.tdsRatePct;
  return taxable > 0 ? Math.round((check.shortBy / taxable) * 10000) / 100 : null;
}

/* ─── New sale ───────────────────────────────────────────────────────────────────────── */

export type SaleCycle = "annual_yearly" | "monthly" | "one_time";

export interface SaleLine {
  itemId: string | null;
  name: string;
  /** Seats for a per-seat product, else quantity. */
  qty: number;
  /** ₹ per seat (unit) for the term: a year (annual), a month (monthly), or once (one-time). */
  rate: number;
  cost: number;
  cycle: SaleCycle;
  perSeat: boolean;
  /** R-2026: the catalogue prices it per MONTH (a seat / unit a month). R-2050: an annual line is
   *  shown and typed ₹/user/YEAR = `rate` (the quote line's unit); this flag only says whether a
   *  line with no catalogue row (or a typed price — R-2053) converts ÷12 / ×12 when its
   *  commitment changes. False for a row priced per year or once (domain, migration, a
   *  yearly-total plan). Absent = true. */
  monthPriced?: boolean;
  /** R-2053: the owner typed this line's price (a deal). A commitment change then converts it
   *  instead of taking the catalogue price. A new product line starts without it. */
  priceTyped?: boolean;
}

type CatalogRow = Pick<Item, "id" | "name" | "vendor" | "msrp" | "wholesale" | "prices"> & { item_type?: string | null };

/** The cycle a catalogue product starts on: one-time items once, everything else annual. */
export function defaultCycle(it: CatalogRow): SaleCycle {
  return billingUnitOf(it) === "one_time" ? "one_time" : "annual_yearly";
}

/** R-2050: the catalogue price for a commitment, never below the Workspace list floor (R-205) —
 *  the quote builder floors its catalogue rows the same way before pricing a line. */
function listRateFor(it: CatalogRow, cycle: SaleCycle): { rate: number; cost: number } {
  return catalogLineListRate(floorWorkspaceRow(it), cycle === "one_time" ? null : cycle);
}

/** A catalogue product → a sale line priced the way the quote builder prices it. */
export function saleLineFromItem(it: CatalogRow, cycle: SaleCycle = defaultCycle(it), seats?: number | null): SaleLine {
  const unit = billingUnitOf(it);
  const p = listRateFor(it, cycle);
  return {
    itemId: it.id,
    name: it.name,
    qty: defaultQtyForUnit(unit, seats ?? null),
    rate: Math.round(p.rate),
    cost: Math.round(p.cost),
    cycle,
    perSeat: isPerSeat(unit),
    monthPriced: isMonthPriced(it),
  };
}

/** R-2026: is this catalogue row priced per month? (the rule catalogLineListRate prices by) */
export function isMonthPriced(it: CatalogRow): boolean {
  return headlinePrice(it).unit !== "yr" && unitYearMultiplier(billingUnitOf(it)) === 12;
}

/** Change the cycle of a catalogue line: re-price it from the catalogue for that term. R-2050: a
 *  line with no catalogue row converts its own price — a year ÷ 12 = a month, a month × 12 = a
 *  year (whole rupees) — so the shown figure keeps its meaning in the new unit. */
export function repriceLine(line: SaleLine, it: CatalogRow | undefined, cycle: SaleCycle): SaleLine {
  /* R-2053: a year ÷ 12 = a month, a month × 12 = a year; to or from one-time the number is kept. */
  const factor = line.monthPriced === false ? 1
    : line.cycle === "annual_yearly" && cycle === "monthly" ? 1 / 12
    : line.cycle === "monthly" && cycle === "annual_yearly" ? 12 : 1;
  if (!it) {
    return { ...line, cycle, rate: Math.round(line.rate * factor), cost: Math.round(line.cost * factor) };
  }
  const p = listRateFor(it, cycle);
  /* R-2053 (Pardeep delegated, 28 Oct): a TYPED price (a deal) is kept and converted; only an
     untouched line takes the floored catalogue price. Cost always follows the catalogue tier. */
  const rate = line.priceTyped ? Math.round(line.rate * factor) : Math.round(p.rate);
  return { ...line, cycle, rate, cost: Math.round(p.cost) };
}

/**
 * The preview the editor shows before saving: qty × rate, GST at the rate the server will use
 * (18, or 0 for an export customer / a Bill of Supply). Display only — the server computes the
 * quote with create_direct_invoice's rule and the result shows ITS total.
 */
/** R-2095: a unit price keeps its paise (Zoho bills ₹103.5, ₹1,347.5) — two decimals at most. */
export function paiseRate(rate: number): number {
  return Number.isFinite(rate) ? Math.round(Math.max(0, rate) * 100) / 100 : 0;
}

export function salePreview(lines: readonly SaleLine[], gstRatePct: number): { taxable: number; gst: number; total: number } {
  /* R-2095: qty × paise rate, summed in paise, rounded to the rupee ONCE (the invoice is in rupees) —
     the server (bank_credit_new_sale_quote) adds the same way. */
  const paise = lines.reduce((s, l) => s + Math.max(0, Math.round(l.qty)) * Math.round(paiseRate(l.rate) * 100), 0);
  const taxable = Math.round(paise / 100);
  const gst = Math.round((taxable * gstRatePct) / 100);
  return { taxable, gst, total: taxable + gst };
}

export function saleMakesSubscription(lines: readonly SaleLine[]): boolean {
  return lines.some((l) => l.cycle !== "one_time");
}

export function rateSuffix(line: Pick<SaleLine, "cycle" | "perSeat">): string {
  const per = line.perSeat ? "/seat" : "";
  return line.cycle === "monthly" ? `${per}/month` : line.cycle === "annual_yearly" ? `${per}/year` : " once";
}

/* ─── R-2026: Commitment first, then Payment — the quote builder's own pair ─────────────────
   Pardeep (27 Oct): Google Workspace prices are decided by the commitment — a monthly
   commitment has its own price and only monthly payment; an annual commitment has its own price
   and the customer pays monthly, quarterly, half-yearly or yearly. The quote builder already has
   both: a line's commitment (price tier — lib/quotes/line-commit-choice) and the quote's
   billing_cycle (how often it is billed — lib/quotes/billing BILLING_CYCLE_OPTIONS). The new-sale
   sheet uses the same two, in that order. */

/** Annual first (the usual sale). Labels are the builder's own. */
const COMMIT_ORDER: readonly CommitChoice[] = ["annual", "monthly", "one_time"];
const CYCLE_OF_CHOICE: Readonly<Record<CommitChoice, SaleCycle>> = { annual: "annual_yearly", monthly: "monthly", one_time: "one_time" };

export interface CommitmentOption { cycle: SaleCycle; label: string }

/** The commitments a line can take — a one-time catalogue row (setup, migration) is One-time only. */
export function commitmentOptions(oneTimeOnly: boolean): CommitmentOption[] {
  return COMMIT_ORDER
    .filter((c) => !oneTimeOnly || c === "one_time")
    .map((c) => ({
      cycle: CYCLE_OF_CHOICE[c],
      label: COMMIT_CHOICES.find((x) => x.value === c)?.label ?? c,
    }));
}

/** The unit price as the operator sees it. R-2050 (Pardeep 28 Oct: "commitment annual hai to annual
 *  price show hona chahiye"): it IS the line's rate — ₹/user/YEAR on an annual commitment (the quote
 *  line's ₹/seat/year), ₹/user/month on Monthly flex, ₹ once on one-time. No ×12 / ÷12. */
export function shownUnitPrice(line: Pick<SaleLine, "rate">): number {
  return line.rate;
}

/** The stored rate for a typed unit price — as typed, paise kept (R-2095; a deal price is not locked). */
export function rateFromShownPrice(_line: Pick<SaleLine, "cycle" | "monthPriced">, shown: number): number {
  return paiseRate(shown);
}

/** "₹/user/year" (annual), "₹/user/month" (Monthly flex), "₹/user, once" — the unit of the shown price. */
export function shownPriceUnit(line: Pick<SaleLine, "cycle" | "perSeat">): string {
  const who = line.perSeat ? "/user" : "";
  if (line.cycle === "one_time") return line.perSeat ? "₹/user, once" : "₹ once";
  if (line.cycle === "monthly") return `₹${who}/month`;
  return `₹${who}/year`;
}

export interface PaymentChoice {
  /** The cycles offered; empty = nothing to ask (a one-time sale is paid once). */
  options: Array<{ id: BillingCycle; label: string }>;
  /** Why the other options are hidden (Monthly flex). */
  why: string | null;
}

/** How the sale can be paid: Annual → BILLING_CYCLE_OPTIONS; Monthly flex → Monthly only. */
export function paymentChoice(lines: ReadonlyArray<Pick<SaleLine, "cycle">>): PaymentChoice {
  if (lines.some((l) => l.cycle === "monthly")) {
    return {
      options: BILLING_CYCLE_OPTIONS.filter((o) => o.id === "monthly"),
      why: "Monthly flex has no commitment, so it is paid monthly only. Choose Annual (1-yr) for yearly, half-yearly or quarterly payment.",
    };
  }
  if (!lines.some((l) => l.cycle === "annual_yearly")) return { options: [], why: null };
  return { options: [...BILLING_CYCLE_OPTIONS], why: null };
}

/** The billing_cycle the sale is saved with — reconcile_bank_credit_new_sale applies the same rule. */
export function saleBillingCycle(lines: ReadonlyArray<Pick<SaleLine, "cycle">>, picked: BillingCycle): BillingCycle {
  if (lines.some((l) => l.cycle === "monthly")) return "monthly";
  if (!lines.some((l) => l.cycle === "annual_yearly")) return "yearly";
  return picked;
}

export interface SaleBill { billOn: string; gross: number }

export interface SaleSchedule {
  /** ₹ incl GST billed now — the first period; the bank amount is matched against it. */
  dueNow: number;
  /** ₹ ex GST of that bill (the TDS base). */
  dueTaxable: number;
  /** The rest of the year's bills (annual commitment paid in parts). */
  later: SaleBill[];
  /** Monthly flex: the same bill again every month. */
  everyMonth: boolean;
  /** R-2095: ₹ incl GST of that monthly bill — the monthly lines only (one-time lines are billed once). */
  monthlyGross?: number;
}

/**
 * What the new sale bills NOW and later. Annual commitment paid quarterly = the first quarter
 * (+ GST) now, then three more — the split the quote, the instalment invoices and
 * quote_split_due all use (lib/billing/instalments quoteInstalmentPlan). No split → the total.
 */
export function saleSchedule(lines: readonly SaleLine[], gstRatePct: number, cycle: BillingCycle, startISO: string): SaleSchedule {
  const p = salePreview(lines, gstRatePct);
  const effective = saleBillingCycle(lines, cycle);
  const flex = lines.some((l) => l.cycle === "monthly");
  if (!flex && isSplitBilled(effective) && p.taxable > 0) {
    const plan = quoteInstalmentPlan({
      cycle: effective, termTaxable: p.taxable, termGross: p.total, taxRate: gstRatePct, termStart: startISO,
    });
    if (plan && plan.lines.length > 1) {
      return {
        dueNow: plan.lines[0].gross,
        dueTaxable: plan.lines[0].taxable,
        later: plan.lines.slice(1).map((l) => ({ billOn: l.billOn, gross: l.gross })),
        everyMonth: false,
      };
    }
  }
  /* R-2095: "then every month" is the monthly lines alone — a one-time line (setup) is billed once. */
  const monthlyGross = flex ? salePreview(lines.filter((l) => l.cycle === "monthly"), gstRatePct).total : 0;
  return { dueNow: p.total, dueTaxable: p.taxable, later: [], everyMonth: flex && monthlyGross > 0, ...(flex ? { monthlyGross } : {}) };
}

/** "Next 3 bills ₹4,814 each, on 21 Jan 2027, 21 Apr 2027 and 21 Jul 2027." */
export function laterBillsText(s: SaleSchedule, cycle: BillingCycle): string | null {
  if (s.everyMonth) return `Then ${rupee(s.monthlyGross ?? s.dueNow)} every month while the plan runs (Monthly flex).`;
  const n = s.later.length;
  if (n === 0) return null;
  const same = s.later.every((b) => b.gross === s.later[0].gross);
  const amount = n === 1 ? rupee(s.later[0].gross)
    : same ? `${rupee(s.later[0].gross)} each`
    : `${rupee(s.later[0].gross)} each (last ${rupee(s.later[n - 1].gross)})`;
  const head = `Next ${n} bill${n === 1 ? "" : "s"} ${amount}`;
  if (n <= 3) {
    const dates = s.later.map((b) => formatDate(b.billOn));
    const on = dates.length === 1 ? dates[0] : `${dates.slice(0, -1).join(", ")} and ${dates[dates.length - 1]}`;
    return `${head}, on ${on}.`;
  }
  return `${head}, ${cycleScheduleLabel(cycle).replace(/^billed /, "")} from ${formatDate(s.later[0].billOn)} to ${formatDate(s.later[n - 1].billOn)}.`;
}

/* ─── R-2052: "Paid up to" beside Renews on ───────────────────────────────────────────────
   Pardeep (28 Oct): an annual commitment billed in parts keeps "Renews on" at the end of the
   1-year commitment (a renewal quote on the 2nd part's day would bill twice — R-807/R-808), and
   says how far the money pays. Extra money is kept as advance credit "used on their next bill"
   (the amount check's own words), so a later part it pays IN FULL counts as paid; a part it
   pays only partly does not. */

export interface PaidUp {
  /** The last day the money covers (YYYY-MM-DD) — the day before the next unpaid part. */
  paidUpTo: string;
  /** The next part still to be billed, or null when the whole year is paid. */
  next: SaleBill | null;
  /** The parts after `next`. */
  rest: SaleBill[];
  cycle: BillingCycle;
}

/** How far the first bill (+ any extra paid) covers an annual commitment billed in parts; null
 *  when there are no later parts (one payment a year, Monthly flex, one-time). */
export function salePaidUp(s: SaleSchedule, extraCredit: number, renewalISO: string, cycle: BillingCycle = "quarterly"): PaidUp | null {
  if (s.everyMonth || s.later.length === 0) return null;
  let left = Math.max(0, extraCredit);
  let i = 0;
  while (i < s.later.length && left >= s.later[i].gross) { left -= s.later[i].gross; i++; }
  if (i >= s.later.length) return { paidUpTo: addDaysISO(renewalISO, -1), next: null, rest: [], cycle };
  return { paidUpTo: addDaysISO(s.later[i].billOn, -1), next: s.later[i], rest: s.later.slice(i + 1), cycle };
}

/** "22-04-2027" — the way the date boxes beside it show a date. */
function dmy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

/**
 * R-2053 — the term, said once under Start date / Renews on: "1 year: 23-10-2026 to 22-10-2027 ·
 * renews 23-10-2027". Renews on is the day the next term STARTS (renewal_date = start + whole
 * terms — the app's rule, read by reminders and renewal billing), so the term ends the day before.
 * "1 month" for Monthly flex; "Term" when the owner edited Renews on. Null when it is not after
 * the start (the form already says so).
 */
export function saleTermText(startISO: string, renewalISO: string): string | null {
  if (!startISO || !renewalISO || renewalISO <= startISO) return null;
  const label = renewalISO === addMonthsClamped(startISO, 12) ? "1 year"
    : renewalISO === addMonthsClamped(startISO, 1) ? "1 month" : "Term";
  return `${label}: ${dmy(startISO)} to ${dmy(addDaysISO(renewalISO, -1))} · renews ${dmy(renewalISO)}`;
}

/** "Paid up to 22-04-2027 · next bill ₹19,116 on 23 Apr 2027." (+ the later parts, said once).
 *  The whole year paid → the term line above already says when it ends (R-2053). */
export function paidUpText(p: PaidUp): string {
  const head = `Paid up to ${dmy(p.paidUpTo)}`;
  if (!p.next) return "The whole year is paid.";
  const next = `${head} · next bill ${rupee(p.next.gross)} on ${formatDate(p.next.billOn)}`;
  const n = p.rest.length;
  if (n === 0) return `${next}.`;
  if (n === 1) return `${next}, then ${rupee(p.rest[0].gross)} on ${formatDate(p.rest[0].billOn)}.`;
  const same = p.rest.every((b) => b.gross === p.rest[0].gross);
  const amount = same ? `${rupee(p.rest[0].gross)} each` : `${rupee(p.rest[0].gross)} each (last ${rupee(p.rest[n - 1].gross)})`;
  if (n <= 3) {
    const dates = p.rest.map((b) => formatDate(b.billOn));
    return `${next}, then ${n} more ${amount}, on ${dates.slice(0, -1).join(", ")} and ${dates[n - 1]}.`;
  }
  return `${next}, then ${n} more ${amount}, ${cycleScheduleLabel(p.cycle).replace(/^billed /, "")} to ${formatDate(p.rest[n - 1].billOn)}.`;
}

/* ─── R-2026 (5): the "Who paid?" list — each customer once, each name once ──────────────────
   Pardeep's staging screenshot read "JAK GROUP PRIVATE LIMITEDJAK GROUP PRIVATE LIMITED". A name
   stored twice over (10+ letters each half, so "Duran Duran" stays) is shown once here; the
   customer record itself is not changed. */
export function customerOptionLabel(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  for (const sep of ["", " "]) {
    const half = (n.length - sep.length) / 2;
    if (half >= 10 && Number.isInteger(half)
        && n.slice(half, half + sep.length) === sep
        && n.slice(0, half).toLowerCase() === n.slice(half + sep.length).toLowerCase()) {
      return n.slice(0, half).trim();
    }
  }
  return n;
}

export function customerOptions(customers: ReadonlyArray<{ id: string; name: string }>): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  for (const c of customers) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, label: customerOptionLabel(c.name) });
  }
  return out;
}

/** The RPC's p_lines. */
export function saleLinesPayload(lines: readonly SaleLine[]) {
  return lines.map((l, i) => ({
    id: `line-${i + 1}`,
    item_id: l.itemId,
    name: l.name.trim(),
    qty: Math.round(l.qty),
    rate: paiseRate(l.rate),   // R-2095: paise kept
    cost: Math.round(l.cost),
    commitment: l.cycle,
  }));
}

/** Mixed monthly + annual on one sale is refused by the server (one quote = one billing term). */
export function saleTermsMixed(lines: readonly SaleLine[]): boolean {
  return lines.some((l) => l.cycle === "monthly") && lines.some((l) => l.cycle === "annual_yearly");
}

/* ─── Subscription dates ─────────────────────────────────────────────────────────────── */

/** The renewal date record_payment would file: start + 1 month (monthly) or + 1 year. */
export function defaultRenewal(startISO: string, monthly: boolean): string {
  return addMonthsClamped(startISO, monthly ? 1 : 12);
}

/** Is a quote's subscription monthly? (its lines say so) */
export function linesAreMonthly(lines: OpenItem["lines"]): boolean {
  return (lines ?? []).some((l) => l?.commitment === "monthly");
}

/* ─── Result ─────────────────────────────────────────────────────────────────────────── */

export interface PayForResult {
  /** "advance" — R-1863: booked as the customer's advance (on account), nothing invoiced.
      "split" — R-2098: several items on one line; each is in parts. */
  kind: OpenItemKind | "advance" | "split";
  quote_id: string | null;
  invoice_id: string | null;
  invoice_issued: string | null;
  payment_id: string;
  receipt_voucher_no: string | null;
  amount: number;
  tds_amount: number;
  outstanding: number;
  is_fully_paid: boolean;
  overpaid_credit: number;
  renewal_rolled_forward: boolean;
  subscription_skipped: boolean;
  already_recorded: boolean;
  subscriptions: Array<{ id: string; plan: string | null; seats: number | null; start_date: string | null; renewal_date: string | null; billing_cycle: string | null }>;
  new_quote?: boolean;
  quote_total?: number;
  /** R-2026: raising the first instalment invoice of a split-billed sale failed (the message). */
  instalment_error?: string | null;
  /* R-1863 advance */
  advance_credit?: number;
  customer_id?: string | null;
  customer_name?: string | null;
  /* R-1863 relink of an old one-off bank sale */
  relinked_from_quote?: string | null;
  relinked_from_invoice?: string | null;
  old_invoice_credited?: string | null;
  old_invoice_voided?: string | null;
  old_credit_note_id?: string | null;
  /* R-2098 split: what each item recorded, the money left as advance, the round-off. */
  parts?: PayForResult[];
  allocated?: number;
  round_off?: number;
  advance_receipt_voucher_no?: string | null;
}

export interface ResultLine { text: string; href?: string; tone?: "ok" | "warn" }

/** A subscription's billing_cycle when it is billed in parts (monthly / quarterly / half-yearly). */
function splitCycle(c: string | null | undefined): BillingCycle | null {
  return isSplitBilled(c as BillingCycle | null) ? (c as BillingCycle) : null;
}

/** R-1863: the after-save line for an advance (Pardeep's wording, card R-1863). */
export function advanceMessage(amount: number, customerName: string): string {
  return `${rupee(amount)} kept as advance for ${customerName} — it will be offered when you record their next payment`;
}

/** "Renewal of Google Workspace (15 seats) paid → subscription renewed to 24 Oct 2027", etc. */
export function resultLines(r: PayForResult): ResultLine[] {
  const out: ResultLine[] = [];
  /* R-2098: several items on one line — each part says what it did, then the rest. A split
     result has no subscriptions of its own (they are on its parts), so this comes first. */
  if (r.kind === "split") {
    for (const p of r.parts ?? []) out.push(...resultLines(p));
    if ((r.advance_credit ?? 0) > 0) {
      out.push({
        text: advanceMessage(r.advance_credit ?? 0, r.customer_name ?? "the customer"),
        href: r.customer_id ? `/customers/${encodeURIComponent(r.customer_id)}` : undefined,
      });
    }
    const ro = r.round_off ?? 0;
    if (ro > 0) out.push({ text: `${rupee(ro)} less came in — written off as round-off (Bank Charges)` });
    else if (ro < 0) out.push({ text: `${rupee(-ro)} more came in — written off as round-off (Bank Charges)` });
    return out;
  }
  const subs = r.subscriptions ?? [];
  const sub = subs[0];
  const subName = sub ? `${sub.plan ?? "subscription"}${sub.seats ? ` (${sub.seats} seats)` : ""}` : "";
  const quoteHref = r.quote_id ? `/quotes/${encodeURIComponent(r.quote_id)}` : undefined;

  /* R-1863: a relink first says what happened to the old one-off sale. */
  if (r.relinked_from_quote) {
    out.push({
      text: r.old_invoice_credited
        ? `Old one-off sale ${r.relinked_from_quote} undone — invoice ${r.old_invoice_credited} reversed by credit note ${r.old_credit_note_id ?? ""}`.trim()
        : r.old_invoice_voided
          ? `Old one-off sale ${r.relinked_from_quote} undone — draft invoice ${r.old_invoice_voided} voided`
          : `Old one-off sale ${r.relinked_from_quote} undone`,
      href: r.old_invoice_credited ? `/invoices/${encodeURIComponent(r.old_invoice_credited)}` : undefined,
    });
  }

  if (r.kind === "advance") {
    out.push({
      text: advanceMessage(r.advance_credit ?? r.amount, r.customer_name ?? "the customer"),
      href: r.customer_id ? `/customers/${encodeURIComponent(r.customer_id)}` : undefined,
    });
    if (r.receipt_voucher_no) out.push({ text: `Receipt voucher ${r.receipt_voucher_no}` });
    return out;
  }

  if (r.already_recorded) {
    out.push({ text: `This payment was already recorded on ${r.quote_id ?? r.invoice_id} — the bank line is now matched to it.`, href: quoteHref });
  } else if (r.kind === "renewal") {
    out.push({
      text: r.renewal_rolled_forward && sub?.renewal_date
        ? `Renewal of ${subName} paid → subscription renewed to ${formatDate(sub.renewal_date)}`
        : `${rupee(r.amount)} recorded on renewal quote ${r.quote_id} — the subscription renews when it is fully paid`,
      href: quoteHref,
    });
  } else if (r.kind === "add_seats") {
    out.push({ text: `Add-seats payment recorded${sub ? ` → ${subName}` : ""}`, href: quoteHref });
  } else if (r.kind === "instalment") {
    out.push({ text: `Instalment ${r.invoice_id} paid${sub ? ` · ${subName}` : ""}` });
  } else {
    out.push({ text: `${rupee(r.amount)} recorded on ${r.new_quote ? "new sale" : "quote"} ${r.quote_id}`, href: quoteHref });
    for (const s of subs) {
      out.push({
        text: `Subscription created: ${s.plan ?? "plan"} × ${s.seats ?? 0}${splitCycle(s.billing_cycle) ? ` · ${cycleScheduleLabel(splitCycle(s.billing_cycle))}` : ""}${s.renewal_date ? `, renews ${formatDate(s.renewal_date)}` : ""}`,
        href: "/subscriptions",
      });
    }
    if (r.subscription_skipped) {
      out.push({ text: "No subscription created for this paid quote — create it from the quote when needed.", href: quoteHref, tone: "warn" });
    }
  }

  if (r.invoice_issued) out.push({ text: `Invoice ${r.invoice_issued} issued`, href: `/invoices/${encodeURIComponent(r.invoice_issued)}` });
  if (r.instalment_error) out.push({ text: `The first bill's invoice was not raised yet (${r.instalment_error}) — the daily billing run raises it.`, tone: "warn" });
  else if (r.invoice_id && r.kind !== "instalment") out.push({ text: `Invoice ${r.invoice_id}`, href: `/invoices/${encodeURIComponent(r.invoice_id)}` });
  if (r.tds_amount > 0) out.push({ text: `${rupee(r.tds_amount)} TDS booked as TDS receivable — collect the certificate (Form 16A)` });
  /* R-2026: paid in parts — the rest of the year is not owed today. R-2048: each part is a payment
     request on its date; its invoice is raised when it is paid (R-2044). */
  const split = subs.map((s) => splitCycle(s.billing_cycle)).find((c) => c !== null) ?? null;
  if (split && r.outstanding > 0 && !r.already_recorded) {
    out.push({ text: `The rest of the year is ${cycleScheduleLabel(split)} — a payment request goes out on each date; its invoice is raised when it is paid.` });
  } else if (r.outstanding > 0 && !r.already_recorded) out.push({ text: `${rupee(r.outstanding)} still due on it`, tone: "warn" });
  if (r.overpaid_credit > 0) out.push({ text: `${rupee(r.overpaid_credit)} extra kept as the customer's advance credit` });
  return out;
}

/* ─── R-1863: old one-off bank sales (booked before R-1838) and their relink ─────────────── */

/** A row of bank_old_one_off_bookings. */
export interface OldOneOffBooking {
  txn_id: string;
  txn_date: string;
  amount: number;
  description: string | null;
  payment_id: string;
  receipt_voucher_no: string | null;
  received_on: string;
  quote_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product: string | null;
  invoice_id: string | null;
  invoice_status: string | null;
  invoice_date: string | null;
  invoice_amount: number;
  /** Why it cannot be relinked from the bank page (null = it can). */
  blocker: "books_locked" | "other_receipts" | "invoice_notes" | null;
}

/** "What will happen" — shown before the operator confirms a relink. Mirrors relink_bank_one_off_sale. */
export function relinkSteps(b: OldOneOffBooking): string[] {
  const steps: string[] = [];
  if (b.invoice_id && b.invoice_status === "draft") {
    steps.push(`Draft invoice ${b.invoice_id} is voided.`);
  } else if (b.invoice_id && b.invoice_status !== "void") {
    steps.push(`Invoice ${b.invoice_id} (${rupee(b.invoice_amount)}${b.invoice_date ? `, ${formatDate(b.invoice_date)}` : ""}) gets a full credit note (GST section 34). It stays in your records with nothing due.`);
  }
  steps.push(`The old receipt${b.receipt_voucher_no ? ` ${b.receipt_voucher_no}` : ""} and one-off quote ${b.quote_id} are removed (the voucher number is kept as cancelled).`);
  steps.push(`${rupee(b.amount)} is then recorded on what you pick below — all in one step, or nothing changes.`);
  return steps;
}

/** The blocker in the owner's words, with where to fix it (§24). */
export function relinkBlocker(b: OldOneOffBooking): { text: string; href: string; action: string } | null {
  switch (b.blocker) {
    case "books_locked":
      return {
        text: `The books are locked over this receipt (${formatDate(b.received_on)})${b.invoice_id ? ` or invoice ${b.invoice_id}` : ""}. Unlock the month, relink, then lock it again.`,
        href: "/accounting/close", action: "Open Close month",
      };
    case "other_receipts":
      return { text: `Quote ${b.quote_id} has other receipts too, so it cannot be undone from the bank line.`, href: `/quotes/${encodeURIComponent(b.quote_id)}`, action: "Open quote" };
    case "invoice_notes":
      return {
        text: `Invoice ${b.invoice_id ?? ""} already has a credit / debit note or TDS entry — settle it from the invoice.`,
        href: `/invoices/${encodeURIComponent(b.invoice_id ?? "")}`, action: "Open invoice",
      };
    default:
      return null;
  }
}
